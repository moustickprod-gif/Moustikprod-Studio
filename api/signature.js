import { requireUser } from './_verifyAuth.js';
import { getFirestoreAccessToken, getFirestoreProjectId } from './_firestoreAuth.js';

// Gestion des demandes de signature — AUTHENTIFIÉ (propriétaire uniquement).
// La collection signatureRequests est verrouillée côté règles Firestore
// (allow read, write: if false) : seul ce endpoint (compte de service) y écrit.
//   POST { action:'create', payload }      → crée signatureRequests/{token}
//   POST { action:'status', tokens:[...] } → renvoie le statut de chaque token
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
  return { stringValue: String(v) };
}
function fromFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireUser(req, res);
  if (!user) return;

  const { action } = req.body || {};
  const accessToken = await getFirestoreAccessToken();
  const projectId = getFirestoreProjectId();
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/signatureRequests`;
  const authHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  try {
    if (action === 'create') {
      const { payload } = req.body;
      if (!payload || !payload.token || !/^[a-zA-Z0-9]{16,}$/.test(payload.token)) {
        return res.status(400).json({ error: 'payload.token invalide' });
      }
      // Le userId est imposé côté serveur : impossible de créer une demande pour un autre compte.
      const doc = { ...payload, userId: user.localId, statut: 'en_attente', dateEnvoi: new Date().toISOString() };
      const fields = Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, toFs(v)]));
      const r = await fetch(`${base}/${payload.token}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ fields }) });
      if (!r.ok) { const e = await r.json(); return res.status(500).json({ error: e?.error?.message || 'Erreur Firestore' }); }
      return res.status(200).json({ ok: true, token: payload.token });
    }

    if (action === 'status') {
      const tokens = (req.body.tokens || []).filter(t => /^[a-zA-Z0-9]{16,}$/.test(t)).slice(0, 50);
      const out = [];
      for (const token of tokens) {
        const r = await fetch(`${base}/${token}`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (!r.ok) { out.push({ token, statut: 'introuvable' }); continue; }
        const raw = await r.json();
        const f = raw.fields || {};
        // On ne renvoie que les demandes appartenant à l'utilisateur connecté.
        if (fromFs(f.userId) !== user.localId) { out.push({ token, statut: 'introuvable' }); continue; }
        out.push({
          token,
          statut: fromFs(f.statut) || 'en_attente',
          signatureData: fromFs(f.signatureData),
          dateSignature: fromFs(f.dateSignature),
          nomSignataire: fromFs(f.nomSignataire),
          raisonRefus: fromFs(f.raisonRefus),
        });
      }
      return res.status(200).json({ ok: true, results: out });
    }

    return res.status(400).json({ error: 'action inconnue' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
