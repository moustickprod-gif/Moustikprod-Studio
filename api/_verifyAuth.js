// Vérification du token Firebase Auth côté serveur (identique au CRM —
// les deux apps partagent le même projet Firebase).
// Variable d'env recommandée : ALLOWED_EMAILS = moustickprod@gmail.com

const FIREBASE_API_KEY =
  process.env.FIREBASE_API_KEY || 'AIzaSyBGFGecF81Pj_JfAmYTHeWFL8uYr3U1noY';

export async function requireUser(req, res) {
  const header = req.headers.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!idToken) {
    res.status(401).json({ error: 'Authentification requise' });
    return null;
  }

  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );

    if (!r.ok) {
      res.status(401).json({ error: 'Session invalide ou expirée — reconnecte-toi' });
      return null;
    }

    const data = await r.json();
    const user = data.users && data.users[0];

    if (!user || user.disabled) {
      res.status(401).json({ error: 'Compte invalide' });
      return null;
    }

    const allowed = (process.env.ALLOWED_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (allowed.length && !allowed.includes((user.email || '').toLowerCase())) {
      res.status(403).json({ error: 'Accès refusé pour ce compte' });
      return null;
    }

    return user;
  } catch (err) {
    res.status(500).json({ error: 'Erreur de vérification auth : ' + err.message });
    return null;
  }
}
