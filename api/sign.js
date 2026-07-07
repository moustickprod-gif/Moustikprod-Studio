import { getFirestoreAccessToken, getFirestoreProjectId } from './_firestoreAuth.js';

// Lecture d'une demande de signature via Firestore REST API, authentifiée par
// compte de service (IAM) — la collection signatureRequests n'est plus accessible
// en lecture/écriture directe depuis un client Firestore non authentifié.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token manquant' });

  try {
    const accessToken = await getFirestoreAccessToken();
    const projectId = getFirestoreProjectId();
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/signatureRequests/${token}`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (response.status === 404) return res.status(404).json({ error: 'Document introuvable ou lien expiré' });
    if (!response.ok) return res.status(500).json({ error: 'Erreur Firestore' });

    const raw = await response.json();
    const fields = raw.fields || {};

    // Convert Firestore field format to plain JS object
    const parse = (v) => {
      if (v.stringValue !== undefined) return v.stringValue;
      if (v.booleanValue !== undefined) return v.booleanValue;
      if (v.integerValue !== undefined) return Number(v.integerValue);
      if (v.doubleValue !== undefined) return v.doubleValue;
      if (v.nullValue !== undefined) return null;
      if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, parse(val)]));
      if (v.arrayValue) return (v.arrayValue.values || []).map(parse);
      return null;
    };

    const data = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, parse(v)]));

    // Vérification expiration
    if (data.dateExpiration && new Date(data.dateExpiration) < new Date()) {
      return res.status(410).json({ error: 'Ce lien de signature a expiré' });
    }

    // Lien déjà utilisé — renvoyer les données complètes pour afficher le document signé
    if (data.statut === 'signé') {
      return res.status(409).json({ ...data, error: 'Ce document a déjà été signé' });
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
