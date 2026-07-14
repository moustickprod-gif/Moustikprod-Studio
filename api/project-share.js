import { getAccessToken, resolveUid, findProjectByShareToken, fromFirestoreFields } from './_lib/firestore-admin.js';

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

    const found = await findProjectByShareToken(accessToken, project, uid, token);
    if (!found) return res.status(404).json({ error: 'Projet introuvable' });
    const { fields } = found;
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
      validationScenario: fields.validationScenario || null,
      validationScript: fields.validationScript || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
