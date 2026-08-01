import { getAccessToken, getFirestoreProjectId, toFirestoreFields, fromFirestoreFields } from './firestore-admin.js';

// Accès serveur-only aux documents OAuth Google. Ces collections sont
// verrouillées côté règles Firestore (`allow read, write: if false`) : SEULES
// les functions serverless y accèdent, via le compte de service (Admin SDK),
// jamais le navigateur. Le refresh token n'est donc jamais exposé au client.
//
// - googleAuth/{uid}       : refresh token + métadonnées de connexion
// - googleAuthState/{state}: mapping state→uid anti-CSRF, usage unique

function base() {
  return `https://firestore.googleapis.com/v1/projects/${getFirestoreProjectId()}/databases/(default)/documents`;
}

async function readDoc(path) {
  const token = await getAccessToken();
  const res = await fetch(`${base()}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read ${path} échec (${res.status})`);
  const data = await res.json();
  return fromFirestoreFields(data.fields || {});
}

// updateMask.fieldPaths est indispensable : un PATCH sans masque remplace tout
// le document par les seuls champs fournis. Par défaut on masque exactement les
// champs de `obj` (utile pour une MAJ partielle comme lastSyncAt plus tard).
async function writeDoc(path, obj, fieldPaths) {
  const token = await getAccessToken();
  const mask = (fieldPaths || Object.keys(obj))
    .map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join('&');
  const res = await fetch(`${base()}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(obj) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Firestore write ${path} échec: ${JSON.stringify(err)}`);
  }
  return res.json();
}

async function deleteDoc(path) {
  const token = await getAccessToken();
  const res = await fetch(`${base()}/${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  // 404 = déjà absent → succès idempotent (utile pour disconnect / state usage unique)
  if (!res.ok && res.status !== 404) throw new Error(`Firestore delete ${path} échec (${res.status})`);
}

// --- googleAuth/{uid} ---
export const readGoogleAuth = (uid) => readDoc(`googleAuth/${uid}`);
export const writeGoogleAuth = (uid, obj, fieldPaths) => writeDoc(`googleAuth/${uid}`, obj, fieldPaths);
export const deleteGoogleAuth = (uid) => deleteDoc(`googleAuth/${uid}`);

// --- googleAuthState/{state} ---
export const readAuthState = (state) => readDoc(`googleAuthState/${state}`);
export const writeAuthState = (state, uid) => writeDoc(`googleAuthState/${state}`, { uid, createdAt: new Date().toISOString() });
export const deleteAuthState = (state) => deleteDoc(`googleAuthState/${state}`);
