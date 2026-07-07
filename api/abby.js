import { requireUser } from './_verifyAuth.js';

// Proxy Abby — AUTHENTIFIÉ (Firebase) + actions en liste blanche.
// La clé ABBY_API_KEY reste côté serveur (variable d'env Vercel).
// Doc : https://docs.abby.fr — Base URL : https://api.app-abby.com
const BASE = 'https://api.app-abby.com';

async function abby(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.ABBY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireUser(req, res);
  if (!user) return;

  if (!process.env.ABBY_API_KEY) {
    return res.status(500).json({ error: 'ABBY_API_KEY non configurée sur Vercel' });
  }

  const { action, payload = {} } = req.body || {};

  try {
    let r;
    switch (action) {
      case 'ping':
        r = await abby('GET', '/organizations?page=1&limit=1');
        break;
      case 'search': {
        const q = encodeURIComponent(payload.q || '');
        const [orgs, contacts] = await Promise.all([
          abby('GET', `/organizations?page=1&limit=10&search=${q}`),
          abby('GET', `/contacts?page=1&limit=10&search=${q}`),
        ]);
        return res.status(200).json({
          ok: true,
          organizations: orgs.data?.docs || [],
          contacts: contacts.data?.docs || [],
        });
      }
      case 'createOrganization':
        r = await abby('POST', '/organization', payload.body);
        break;
      case 'updateOrganization':
        if (!payload.id) return res.status(400).json({ error: 'id requis' });
        r = await abby('PUT', `/organization/${encodeURIComponent(payload.id)}`, payload.body);
        break;
      case 'createContact':
        r = await abby('POST', '/contact', payload.body);
        break;
      case 'updateContact':
        if (!payload.id) return res.status(400).json({ error: 'id requis' });
        r = await abby('PUT', `/contact/${encodeURIComponent(payload.id)}`, payload.body);
        break;
      case 'createOrganizationContact':
        if (!payload.id) return res.status(400).json({ error: 'id requis' });
        r = await abby('POST', `/organization/${encodeURIComponent(payload.id)}/contact`, payload.body);
        break;
      case 'createEstimate':
        if (!payload.customerId) return res.status(400).json({ error: 'customerId requis' });
        r = await abby('POST', `/v2/billing/estimate/${encodeURIComponent(payload.customerId)}`, { estimateType: 'estimate' });
        break;
      case 'setLines':
        if (!payload.billingId) return res.status(400).json({ error: 'billingId requis' });
        r = await abby('PATCH', `/v2/billing/${encodeURIComponent(payload.billingId)}/lines`, { lines: payload.lines || [] });
        break;
      default:
        return res.status(400).json({ error: 'action inconnue : ' + action });
    }
    if (!r.ok) {
      return res.status(r.status).json({ error: r.data?.message || r.data?.error || ('Erreur Abby ' + r.status), details: r.data });
    }
    res.status(200).json({ ok: true, data: r.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
