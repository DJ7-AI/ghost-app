// /api/roast.js
// Secure server-side proxy for Claude API
// Keeps API key off the client, adds rate limiting and input sanitization

export const config = { runtime: 'edge' };

// In-memory rate limiting (use Vercel KV in production for persistence across instances)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 20; // max 20 calls per minute per IP

// Allowed origins (update with your real domain)
const ALLOWED_ORIGINS = [
  'https://ghostyourself.app',
  'https://www.ghostyourself.app',
  'https://ghost-app.vercel.app',
  // Add your Vercel preview URL pattern if needed
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow vercel preview deployments
  if (origin.endsWith('.vercel.app')) return true;
  // Allow localhost for development
  if (origin.startsWith('http://localhost')) return true;
  return false;
}

function getRateLimitEntry(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) {
    return { count: 0, reset: now + RATE_LIMIT_WINDOW };
  }
  return entry;
}

function sanitizeGoalName(name) {
  if (typeof name !== 'string') return '';
  // Remove any attempts to inject instructions
  return name
    .slice(0, 100) // hard length limit
    .replace(/[<>]/g, '') // strip HTML
    .replace(/ignore|disregard|forget|system|prompt|instruction/gi, '***') // basic prompt injection guard
    .trim();
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-30) // max 30 messages (keeps context window sane)
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string'
        ? m.content.slice(0, 2000) // cap each message at 2000 chars
        : '',
    }))
    .filter(m => m.content.length > 0);
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';

  // CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  // Rate limiting by IP
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const limit = getRateLimitEntry(ip);
  limit.count++;
  rateLimitMap.set(ip, limit);

  if (limit.count > RATE_LIMIT_MAX) {
    return new Response(JSON.stringify({ error: 'Too many requests. Slow down.' }), {
      status: 429,
      headers: { ...corsHeaders, 'content-type': 'application/json', 'Retry-After': '60' },
    });
  }

  // Parse body
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  const { messages, system, maxTokens = 300, goalName } = body;

  // Validate
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'Invalid messages' }), {
      status: 400,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  // Sanitize inputs
  const safeMessages = sanitizeMessages(messages);
  const safeSystem = typeof system === 'string' ? system.slice(0, 3000) : '';
  const safeMaxTokens = Math.min(Math.max(Number(maxTokens) || 300, 50), 500);

  // If goalName is provided, sanitize it
  const safeGoalName = goalName ? sanitizeGoalName(goalName) : null;
  const finalSystem = safeGoalName
    ? safeSystem.replace(/{GOAL_NAME}/g, safeGoalName)
    : safeSystem;

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    return new Response(JSON.stringify({ error: 'Service not configured' }), {
      status: 503,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  // Call Claude
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: safeMaxTokens,
        system: finalSystem || undefined,
        messages: safeMessages,
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', claudeRes.status, errText);
      return new Response(JSON.stringify({ error: 'AI service error' }), {
        status: 502,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    const data = await claudeRes.json();
    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'content-type': 'application/json',
        'cache-control': 'no-store, no-cache',
      },
    });
  } catch (err) {
    console.error('Proxy error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
}
