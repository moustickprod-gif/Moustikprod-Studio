import { requireUser } from './_verifyAuth.js';

// Envoi d'emails via Brevo — AUTHENTIFIÉ.
// Avant (CRM) : endpoint ouvert = relais de spam via le compte Brevo.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireUser(req, res);
  if (!user) return;

  const { to, subject, html } = req.body || {};
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Clé API Brevo manquante' });
  if (!to || !subject || !html) return res.status(400).json({ error: 'Paramètres manquants (to, subject, html)' });

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Moustikprod', email: 'contact@moustikprod.fr' },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Erreur Brevo', details: data });
    res.status(200).json({ ok: true, messageId: data.messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
