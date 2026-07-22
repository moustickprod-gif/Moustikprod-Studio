import { requireUser } from './_verifyAuth.js';

// Proxy Claude API — AUTHENTIFIÉ. Seul un utilisateur Firebase connecté
// (et autorisé via ALLOWED_EMAILS) peut consommer la clé Anthropic.
// Pas de CORS ouvert : l'endpoint n'est appelé qu'en same-origin.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireUser(req, res);
  if (!user) return; // 401/403 déjà envoyé

  const { system, messages, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages requis' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: Math.min(Number(max_tokens) || 16000, 32000),
        thinking: { type: 'adaptive' },
        system,
        messages
      })
    });
    const data = await response.json();
    if (data.error) {
      console.error('[api/claude] Erreur Anthropic:', response.status, JSON.stringify(data.error));
    }
    res.status(200).json(data);
  } catch (err) {
    console.error('[api/claude] Exception:', err);
    res.status(500).json({ error: err.message });
  }
}
