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

function fromFirestoreValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) return fromFirestoreFields(v.mapValue.fields || {});
  return null;
}
function fromFirestoreFields(fields) {
  const out = {};
  for (const k in fields) out[k] = fromFirestoreValue(fields[k]);
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = (req.query.token || '').trim();
  if (!token || !/^[a-zA-Z0-9]{10,}$/.test(token)) {
    return res.status(400).json({ error: 'Jeton de partage invalide' });
  }

  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    const accessToken = await getAccessToken(serviceAccount);
    const uid = await resolveUid(accessToken, process.env.STUDIO_OWNER_EMAIL);
    const project = serviceAccount.project_id;

    const queryRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}/projets:runQuery`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'projets' }],
            where: { fieldFilter: { field: { fieldPath: 'shareToken' }, op: 'EQUAL', value: { stringValue: token } } },
            limit: 1,
          },
        }),
      }
    );
    const queryData = await queryRes.json();
    const doc = (queryData || []).find(r => r.document)?.document;
    if (!doc) return res.status(404).json({ error: 'Projet introuvable' });

    const fields = fromFirestoreFields(doc.fields || {});
    if (!fields.shareEnabled) return res.status(403).json({ error: 'Le partage a été désactivé pour ce projet' });

    let clientNom = '';
    if (fields.clientId) {
      try {
        const clientRes = await fetch(
          `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}/clients/${fields.clientId}`,
          { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        if (clientRes.ok) {
          const clientDoc = await clientRes.json();
          clientNom = fromFirestoreFields(clientDoc.fields || {}).nom || '';
        }
      } catch (e) { /* pas bloquant */ }
    }

    // Contenu créatif + nom du client uniquement. Jamais de coordonnées client.
    res.status(200).json({
      titre: fields.titre || '',
      client: clientNom,
      typeVideo: fields.typeVideo || '',
      statutStudio: fields.statutStudio || '',
      pitch: fields.pitch || '',
      idees: fields.idees || '',
      aPenser: fields.aPenser || '',
      scenario: fields.scenario || '',
      decoupage: fields.decoupage || [],
      matos: fields.matos || [],
      lieu: fields.lieu || '',
      moodboardNotes: fields.moodboardNotes || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
