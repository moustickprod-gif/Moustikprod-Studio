import { getFirestoreAccessToken, getFirestoreProjectId } from '../_firestoreAuth.js';

// Alias conservé pour project-share.js (signature/appel inchangés) — délègue à
// _firestoreAuth.js, qui met le token OAuth2 en cache en mémoire au lieu de
// resigner un JWT à chaque appel. Le paramètre serviceAccount n'est plus utilisé
// ici (getFirestoreAccessToken relit process.env.FIREBASE_SERVICE_ACCOUNT_KEY
// lui-même) mais reste accepté pour ne pas casser les appelants existants.
export const getAccessToken = () => getFirestoreAccessToken();
export { getFirestoreProjectId };

export async function resolveUid(accessToken, email) {
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: [email] }),
  });
  const data = await res.json();
  const uid = data.users && data.users[0] && data.users[0].localId;
  if (!res.ok || !uid) throw new Error('Utilisateur introuvable pour cet email: ' + JSON.stringify(data));
  return uid;
}

export function fromFirestoreValue(v) {
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

export function fromFirestoreFields(fields) {
  const out = {};
  for (const k in fields) out[k] = fromFirestoreValue(fields[k]);
  return out;
}

export function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}

export function toFirestoreFields(obj) {
  const fields = {};
  for (const k in obj) fields[k] = toFirestoreValue(obj[k]);
  return fields;
}

// Retrouve un projet par son shareToken dans users/{uid}/projets. Utilisé à la
// fois par la lecture publique (project-share.js) et l'écriture de validation
// (project-validate.js) pour ne pas dupliquer la requête runQuery.
export async function findProjectByShareToken(accessToken, projectId, uid, token) {
  // Le "parent" d'un runQuery doit être un chemin de document (segments pairs),
  // pas la collection elle-même : users/{uid} est le document parent, et
  // structuredQuery.from{collectionId:'projets'} désigne la sous-collection à
  // interroger. users/{uid}/projets:runQuery (3 segments) est un chemin invalide
  // et renvoie 400 côté Firestore.
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}:runQuery`,
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
  if (!res.ok) throw new Error(`Requête Firestore échouée (${res.status})`);
  const queryData = await res.json();
  const doc = (Array.isArray(queryData) ? queryData : []).find(r => r.document)?.document;
  if (!doc) return null;
  const projetId = doc.name.split('/').pop();
  return { projetId, fields: fromFirestoreFields(doc.fields || {}) };
}

// Met à jour un unique champ top-level d'un projet sans toucher au reste du
// document. updateMask.fieldPaths est indispensable : un PATCH Firestore sans
// ce paramètre remplace tout le document par les seuls champs fournis dans le
// body, ce qui effacerait scenario/decoupage/etc.
export async function patchProjectField(accessToken, projectId, uid, projetId, fieldName, value) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}/projets/${projetId}?updateMask.fieldPaths=${encodeURIComponent(fieldName)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields({ [fieldName]: value }) }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`Écriture Firestore échouée: ${JSON.stringify(errBody)}`);
  }
  return res.json();
}
