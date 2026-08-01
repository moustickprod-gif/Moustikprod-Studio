import { requireUser } from '../_verifyAuth.js';
import { readGoogleAuth, deleteGoogleAuth } from '../_lib/google-store.js';

// Déconnexion Google Calendar (T3). AUTHENTIFIÉ (token Firebase).
// Révoque le refresh token côté Google (best-effort) puis efface le doc
// serveur-only googleAuth/{uid} — pour repartir de zéro proprement si un test
// du flow échoue. Le refresh token ne transite jamais vers le client.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const doc = await readGoogleAuth(user.localId);
    if (doc && doc.refreshToken) {
      // Révocation best-effort : on ne fait pas échouer la déconnexion locale
      // si Google renvoie une erreur (token déjà expiré/révoqué, etc.).
      try {
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: doc.refreshToken }).toString(),
        });
      } catch (_) { /* ignore */ }
    }
    await deleteGoogleAuth(user.localId);
    res.status(200).json({ connected: false });
  } catch (err) {
    res.status(500).json({ error: 'Erreur de déconnexion Google : ' + err.message });
  }
}
