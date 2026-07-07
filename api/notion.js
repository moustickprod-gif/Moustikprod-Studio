import { requireUser } from './_verifyAuth.js';

// Proxy Notion — AUTHENTIFIÉ + endpoints en liste blanche.
// Avant : n'importe qui pouvait appeler n'importe quel endpoint Notion
// avec le token serveur (lecture/écriture de tout le workspace).
const ALLOWED = [
  { method: 'POST',  pattern: /^pages$/ },
  { method: 'PATCH', pattern: /^pages\/[a-zA-Z0-9-]+$/ },
  { method: 'PATCH', pattern: /^blocks\/[a-zA-Z0-9-]+\/children$/ },
];

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const endpoint = String(req.query.endpoint || '');
  const ok = ALLOWED.some(r => r.method === req.method && r.pattern.test(endpoint));
  if (!ok) return res.status(403).json({ error: `Endpoint Notion non autorisé : ${req.method} ${endpoint}` });

  try {
    const response = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
