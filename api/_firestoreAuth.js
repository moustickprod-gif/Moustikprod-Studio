import crypto from 'crypto';

// Authentifie les fonctions serverless auprès de Firestore via le compte de
// service Google (IAM), ce qui contourne les règles de sécurité Firestore —
// indispensable pour des endpoints publics (webhooks Stripe, liens de signature)
// qui doivent écrire dans des collections que les clients ne doivent JAMAIS
// pouvoir lire/écrire directement (signatureRequests, stripeSubscriptions).
// Sans ceci, ces fonctions appelaient l'API REST Firestore sans authentification,
// ce qui exigeait des règles Firestore ouvertes (allow read, write: if true) —
// une faille de sécurité majeure permettant à quiconque de lire/modifier ces
// collections directement depuis un navigateur.
let _cachedToken = null;
let _cachedExpiry = 0;

export async function getFirestoreAccessToken() {
  if (_cachedToken && Date.now() < _cachedExpiry - 60000) return _cachedToken;

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const toSign = `${b64url(header)}.${b64url(claim)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(toSign), serviceAccount.private_key).toString('base64url');
  const jwt = `${toSign}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Impossible d\'obtenir un access token Google: ' + JSON.stringify(data));

  _cachedToken = data.access_token;
  _cachedExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return _cachedToken;
}

export function getFirestoreProjectId() {
  return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY).project_id;
}
