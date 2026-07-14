import { getFirestoreAccessToken, getFirestoreProjectId } from './_firestoreAuth.js';
import { resolveUid, findProjectByShareToken, patchProjectField } from './_lib/firestore-admin.js';

const TARGET_FIELD = { scenario: 'validationScenario', script: 'validationScript' };
const TARGET_LABEL = { scenario: 'Scénario', script: 'Découpage technique' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const body = req.body || {};
  const token = String(body.token || '').trim();
  const target = body.target;
  const decision = body.decision;
  const comment = String(body.comment || '').trim().slice(0, 2000);

  if (!token || !/^[a-zA-Z0-9]{10,}$/.test(token)) {
    return res.status(400).json({ error: 'Jeton de partage invalide' });
  }
  if (!TARGET_FIELD[target]) {
    return res.status(400).json({ error: 'Élément à valider invalide' });
  }
  if (decision !== 'valide' && decision !== 'refuse') {
    return res.status(400).json({ error: 'Décision invalide' });
  }
  if (decision === 'refuse' && !comment) {
    return res.status(400).json({ error: 'Un commentaire est requis pour demander une modification' });
  }

  try {
    const accessToken = await getFirestoreAccessToken();
    const projectId = getFirestoreProjectId();
    const uid = await resolveUid(accessToken, process.env.STUDIO_OWNER_EMAIL);

    const found = await findProjectByShareToken(accessToken, projectId, uid, token);
    if (!found) return res.status(404).json({ error: 'Projet introuvable' });
    const { projetId, fields } = found;
    if (!fields.shareEnabled) return res.status(403).json({ error: 'Le partage a été désactivé pour ce projet' });

    const fieldName = TARGET_FIELD[target];
    const value = {
      status: decision,
      comment: decision === 'refuse' ? comment : null,
      respondedAt: new Date().toISOString(),
    };

    await patchProjectField(accessToken, projectId, uid, projetId, fieldName, value);

    // La notification email ne doit jamais faire échouer la validation
    // elle-même : Firestore est déjà à jour à ce stade.
    try {
      await sendValidationNotification({
        titre: fields.titre || 'Projet sans titre',
        projetId,
        targetLabel: TARGET_LABEL[target],
        decision,
        comment,
      });
    } catch (emailErr) {
      console.error('project-validate: notification Brevo échouée', emailErr);
    }

    return res.status(200).json({ ok: true, field: fieldName, value });
  } catch (err) {
    console.error('project-validate error', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
}

// Pattern calqué sur submit-signature.js : appel Brevo inline, guard sur
// process.env.BREVO_API_KEY, destinataire propriétaire en dur (même adresse
// que submit-signature.js pour les notifs de refus de devis).
async function sendValidationNotification({ titre, projetId, targetLabel, decision, comment }) {
  if (!process.env.BREVO_API_KEY) return; // notification non bloquante si non configurée

  const appUrl = process.env.STUDIO_APP_URL || 'https://moustikprod-studio.vercel.app';
  const projectLink = `${appUrl}/?openProject=${encodeURIComponent(projetId)}`;
  const isValide = decision === 'valide';
  const subject = isValide
    ? `✅ ${targetLabel} validé — ${titre}`
    : `✏️ Modification demandée sur le ${targetLabel.toLowerCase()} — ${titre}`;

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#111111">
      <p>${isValide ? 'Bonne nouvelle, le client a validé un élément du projet.' : 'Le client demande une modification.'}</p>
      <p>
        <strong>Projet :</strong> ${escapeHtml(titre)}<br>
        <strong>Élément :</strong> ${escapeHtml(targetLabel)}<br>
        <strong>Décision :</strong> ${isValide ? 'Validé ✅' : 'Modification demandée ✏️'}
      </p>
      ${!isValide && comment ? `<p><strong>Commentaire du client :</strong><br>${escapeHtml(comment).replace(/\n/g, '<br>')}</p>` : ''}
      <p style="margin-top:20px">
        <a href="${projectLink}" style="display:inline-block;background:#3CD6D1;color:#024059;font-weight:700;padding:10px 22px;border-radius:8px;text-decoration:none">
          Ouvrir le projet dans Studio
        </a>
      </p>
    </div>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Moustikprod', email: 'contact@moustikprod.fr' },
      to: [{ email: 'contact@moustikprod.fr' }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.message || `Brevo error ${res.status}`);
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
