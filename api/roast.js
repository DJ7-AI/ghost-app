const https = require('https');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.GROQ_API_KEY;
  console.log('[Ghost] Key present:', !!key, '| Key prefix:', key ? key.slice(0,8) : 'NONE');
  if (!key) return res.status(503).json({ error: 'No API key — GROQ_API_KEY not found in env' });

  let body;
  try { body = await readBody(req); } catch(e) { return res.status(400).json({ error: 'Bad JSON' }); }

  const msgs = [];
  if (body.system) msgs.push({ role: 'system', content: String(body.system).slice(0, 2000) });
  (body.messages || []).slice(-20).forEach(m => {
    if (m && m.content) msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 2000) });
  });
  if (!msgs.length) return res.status(400).json({ error: 'No messages' });

  const payload = JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 400, messages: msgs, temperature: 0.9 });

  return new Promise(resolve => {
    const req2 = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        console.log('[Ghost] Groq status:', r.statusCode, d.slice(0, 200));
        if (r.statusCode !== 200) { res.status(502).json({ error: 'Groq ' + r.statusCode, detail: d }); return resolve(); }
        try { res.status(200).json({ text: JSON.parse(d).choices[0].message.content }); }
        catch(e) { res.status(500).json({ error: e.message }); }
        resolve();
      });
    });
    req2.on('error', e => { res.status(500).json({ error: e.message }); resolve(); });
    req2.write(payload);
    req2.end();
  });
};
