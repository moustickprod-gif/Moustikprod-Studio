import { readAuthState, deleteAuthState, writeGoogleAuth } from '../_lib/google-store.js';

// Cible du redirect Google (T3). C'est une navigation navigateur : PAS d'en-tête
// d'auth. On authentifie via le `state` (créé par /api/google/auth, mappé à
// l'uid côté serveur, usage unique). Puis on échange le `code` contre un refresh
// token et on le stocke dans le doc serveur-only googleAuth/{uid}.
//
// Le refresh token n'est ni loggué, ni renvoyé au client : il ne quitte jamais
// le serveur. On termine par une redirection vers l'app avec un statut lisible.
function redirectToApp(res, status) {
  res.setHeader('Location', `/?gcal=${status}`);
  res.status(302).end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { code, state, error } = req.query || {};

  if (error) return redirectToApp(res, 'refus');        // l'utilisateur a refusé le consentement
  if (!code || !state) return redirectToApp(res, 'erreur');

  try {
    const mapping = await readAuthState(String(state));
    if (!mapping || !mapping.uid) return redirectToApp(res, 'erreur');
    // Usage unique : le state est invalidé quoi qu'il advienne ensuite.
    await deleteAuthState(String(state));

    // Expiration ~10 min : un state trop vieux (onglet abandonné, erreur Google
    // avant le callback) est rejeté. Renforce l'anti-CSRF et évite d'exploiter
    // un doc state resté orphelin. Le doc vient d'être supprimé ci-dessus.
    const ageMs = Date.now() - new Date(mapping.createdAt || 0).getTime();
    if (!(ageMs >= 0) || ageMs > 10 * 60 * 1000) return redirectToApp(res, 'erreur');

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) return redirectToApp(res, 'config');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const tokens = await tokenRes.json();

    // Sans refresh_token la connexion est inexploitable pour une synchro
    // récurrente (ex. consentement déjà donné sans prompt=consent) : on ne
    // stocke rien et on signale le cas.
    if (!tokenRes.ok || !tokens.refresh_token) return redirectToApp(res, 'sans_refresh');

    await writeGoogleAuth(mapping.uid, {
      refreshToken: tokens.refresh_token,
      calendarId: 'primary',
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
    });
    return redirectToApp(res, 'connecte');
  } catch (err) {
    return redirectToApp(res, 'erreur');
  }
}
