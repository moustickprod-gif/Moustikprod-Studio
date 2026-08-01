import crypto from 'crypto';
import { requireUser } from './_verifyAuth.js';
import {
  readGoogleAuth, writeGoogleAuth, deleteGoogleAuth,
  readAuthState, writeAuthState, deleteAuthState,
} from './_lib/google-store.js';

// Point d'entrée UNIQUE pour l'OAuth Google Calendar (T3).
// Regroupé en une seule fonction serverless pour rester sous la limite de 12
// fonctions du plan Hobby. Fonction STATIQUE (api/google.js) — le routing
// dynamique [action].js ne se résout pas de façon fiable avec le rewrite SPA
// catch-all de vercel.json. Les URLs publiques /api/google/{auth,callback,
// status,disconnect} sont préservées par un rewrite explicite dans vercel.json
// qui mappe /api/google/:action → /api/google?action=:action (rewrite interne,
// l'URL vue par le navigateur/Google ne change pas). On lit donc req.query.action.
// Logique et sécurité identiques aux routes d'origine (state anti-CSRF usage
// unique + expiration 10 min, refresh token jamais exposé).
const SCOPE = 'https://www.googleapis.com/auth/calendar';

export default async function handler(req, res) {
  switch (req.query.action) {
    case 'auth':       return handleAuth(req, res);
    case 'callback':   return handleCallback(req, res);
    case 'status':     return handleStatus(req, res);
    case 'disconnect': return handleDisconnect(req, res);
    default:           return res.status(404).json({ error: 'Action Google inconnue' });
  }
}

// GET /api/google/auth — démarre le flow (authentifié). Renvoie l'URL de
// consentement (access_type=offline + prompt=consent → refresh_token garanti)
// avec un state aléatoire, usage unique, mappé à l'uid côté serveur.
async function handleAuth(req, res) {
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

// GET /api/google/callback — cible du redirect Google (navigation, pas d'en-tête
// d'auth). Authentifie via le `state`, échange le code contre un refresh token
// stocké dans googleAuth/{uid}, puis redirige vers l'app avec un statut lisible.
function redirectToApp(res, status) {
  res.setHeader('Location', `/?gcal=${status}`);
  res.status(302).end();
}

async function handleCallback(req, res) {
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
    // récurrente : on ne stocke rien et on signale le cas.
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

// GET /api/google/status — statut de connexion pour l'UI (authentifié).
// Ne renvoie JAMAIS le refresh token.
async function handleStatus(req, res) {
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

// POST /api/google/disconnect — révoque le refresh token côté Google
// (best-effort) puis efface le doc serveur-only. Permet de repartir de zéro.
async function handleDisconnect(req, res) {
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
