import { requireUser } from '../_verifyAuth.js';
import { readGoogleAuth } from '../_lib/google-store.js';

// Statut de connexion Google Calendar pour l'UI (T3).
// AUTHENTIFIÉ (token Firebase). Ne renvoie JAMAIS le refresh token — seulement
// des champs non sensibles pour afficher l'état connecté/déconnecté.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const doc = await readGoogleAuth(user.localId);
    res.status(200).json({
      connected: !!(doc && doc.refreshToken),
      calendarId: (doc && doc.calendarId) || 'primary',
      connectedAt: (doc && doc.connectedAt) || null,
      lastSyncAt: (doc && doc.lastSyncAt) || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur de lecture du statut Google : ' + err.message });
  }
}
