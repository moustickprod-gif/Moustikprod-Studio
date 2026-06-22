import crypto from 'crypto';

// Échange la clé de compte de service Google contre un access token OAuth2,
// sans dépendance npm (signature JWT RS256 faite à la main avec le module crypto natif).
async function getAccessToken(serviceAccount) {
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
  return data.access_token;
}

async function resolveUid(accessToken, email) {
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: [email] }),
  });
  const data = await res.json();
  const uid = data.users && data.users[0] && data.users[0].localId;
  if (!uid) throw new Error('Utilisateur introuvable pour cet email: ' + JSON.stringify(data));
  return uid;
}

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  return { stringValue: String(v) };
}

function frenchWeekLabel(date) {
  const monday = new Date(date);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString('fr-FR', { day:'numeric', month:'long' });
  return { weekStart: monday.toISOString().slice(0,10), weekLabel: `Semaine du ${fmt(monday)} au ${fmt(sunday)}` };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.IDEAS_INGEST_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const { etude, idees } = req.body;
    if (!etude && !(idees && idees.length)) {
      return res.status(400).json({ error: 'Le corps doit contenir "etude" et/ou "idees"' });
    }

    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    const accessToken = await getAccessToken(serviceAccount);
    const uid = await resolveUid(accessToken, process.env.STUDIO_OWNER_EMAIL);

    const { weekStart, weekLabel } = frenchWeekLabel(new Date());
    const idCode = `idea_${Date.now()}`;
    const fields = {
      id: { stringValue: idCode },
      weekStart: { stringValue: weekStart },
      weekLabel: { stringValue: weekLabel },
      etude: { stringValue: etude || '' },
      idees: toFirestoreValue(Array.isArray(idees) ? idees : (idees ? [idees] : [])),
      createdAt: { stringValue: new Date().toISOString() },
    };

    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/users/${uid}/idees/${idCode}`;
    const writeRes = await fetch(firestoreUrl, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    const writeData = await writeRes.json();
    if (!writeRes.ok) throw new Error(JSON.stringify(writeData));

    res.status(200).json({ ok: true, id: idCode, weekLabel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
