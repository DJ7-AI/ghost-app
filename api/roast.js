const https = require('https');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try { body = await readBody(req); }
  catch(e) { return res.status(400).json({ error: 'Bad JSON' }); }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No API key configured' });

  const { messages = [], system, maxTokens = 300 } = body;

  const groqMessages = [];
  if (system) groqMessages.push({ role: 'system', content: String(system).slice(0, 2000) });
  messages.slice(-20).forEach(m => {
    if (m.content) groqMessages.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content).slice(0, 2000)
    });
  });

  const payload = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    max_tokens: Math.min(maxTokens, 500),
    messages: groqMessages,
    temperature: 0.9,
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    };

    const request = https.request(options, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        console.log('[Ghost] Groq status:', response.statusCode);
        if (response.statusCode !== 200) {
          console.error('[Ghost] Groq error:', data);
          res.status(502).json({ error: 'AI error ' + response.statusCode, detail: data });
          return resolve();
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices[0].message.content;
          res.status(200).json({ text });
        } catch(e) {
          res.status(500).json({ error: 'Parse error: ' + e.message });
        }
        resolve();
      });
    });

    request.on('error', err => {
      console.error('[Ghost] Request error:', err.message);
      res.status(500).json({ error: err.message });
      resolve();
    });

    request.write(payload);
    request.end();
  });
};
