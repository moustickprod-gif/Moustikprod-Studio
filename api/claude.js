import { requireUser } from './_verifyAuth.js';

// Proxy Claude API — AUTHENTIFIÉ. Seul un utilisateur Firebase connecté
// (et autorisé via ALLOWED_EMAILS) peut consommer la clé Anthropic.
// Pas de CORS ouvert : l'endpoint n'est appelé qu'en same-origin.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireUser(req, res);
  if (!user) return; // 401/403 déjà envoyé

  const { system, messages, max_tokens, stream } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages requis' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: Math.min(Number(max_tokens) || 4096, 8192),
        system,
        messages,
        stream: !!stream
      })
    });

    if (!stream) {
      const data = await upstream.json();
      return res.status(upstream.status).json(data);
    }

    // Relais SSE brut vers le front — aucune transformation, les octets
    // renvoyés par Anthropic sont retransmis tels quels.
    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
}
