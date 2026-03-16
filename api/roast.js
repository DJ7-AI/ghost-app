// /api/roast.js — Standard Node.js Serverless Function
// Switched from Edge runtime — process.env works reliably here

const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 20;
const rateLimitMap = new Map();

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin.endsWith('.vercel.app')) return true;
  if (origin.startsWith('http://localhost')) return true;
  if (origin.startsWith('http://127.0.0.1')) return true;
  return false;
}

function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) {
    const fresh = { count: 0, reset: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, fresh);
    return fresh;
  }
  return entry;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-30)
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content.slice(0, 2000) : '',
    }))
    .filter(m => m.content.length > 0);
}

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';

  res.setHeader('Access-Control-Allow-Origin', isAllowedOrigin(origin) ? (origin || '*') : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const limit = getRateLimit(ip);
  limit.count++;
  if (limit.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Slow down.' });
  }

  const body = req.body;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const { messages, system, maxTokens = 300 } = body;
  const safeMessages = sanitizeMessages(messages);
  const safeSystem = typeof system === 'string' ? system.slice(0, 3000) : undefined;
  const safeMaxTokens = Math.min(Math.max(Number(maxTokens) || 300, 50), 500);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[Ghost] ANTHROPIC_API_KEY not set');
    return res.status(503).json({ error: 'Service not configured' });
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: safeMaxTokens,
        ...(safeSystem ? { system: safeSystem } : {}),
        messages: safeMessages,
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('[Ghost] Claude error:', claudeRes.status, errText);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await claudeRes.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json({ text });

  } catch (err) {
    console.error('[Ghost] Proxy error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
