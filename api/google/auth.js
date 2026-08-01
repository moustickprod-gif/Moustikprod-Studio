import crypto from 'crypto';
import { requireUser } from '../_verifyAuth.js';
import { writeAuthState } from '../_lib/google-store.js';

// Démarre le flow OAuth Google Calendar (T3).
// Appelée par le bouton « Connecter Google Calendar » via fetch, AVEC le token
// Firebase (vérifié par requireUser). On ne redirige PAS ici : on renvoie l'URL
// de consentement au client, qui fait lui-même la redirection navigateur.
//
// - access_type=offline + prompt=consent  → garantit un refresh_token à chaque
//   connexion (sinon Google n'en renvoie un qu'au tout premier consentement).
// - state  → aléatoire, usage unique, mappé à l'uid côté serveur (googleAuthState)
//   pour authentifier le callback (qui n'a pas d'en-tête d'auth) et bloquer le CSRF.
const SCOPE = 'https://www.googleapis.com/auth/calendar';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = await requireUser(req, res);
  if (!user) return;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'Configuration OAuth Google manquante (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_REDIRECT_URI).' });
  }

  try {
    const state = crypto.randomBytes(24).toString('hex');
    await writeAuthState(state, user.localId);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state,
    });
    res.status(200).json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  } catch (err) {
    res.status(500).json({ error: 'Impossible de démarrer la connexion Google : ' + err.message });
  }
}
