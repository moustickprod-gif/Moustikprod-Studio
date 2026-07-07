import { getFirestoreAccessToken, getFirestoreProjectId } from './_firestoreAuth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { token, signatureData, nomSignataire, decision, raisonRefus, commentaireRefus, cgvAcceptees, cgvAccepteesDate, droitImageInclus } = req.body;
  console.log('[submit-signature] Token reçu:', token, '| décision:', decision || 'signature');

  if (!token) return res.status(400).json({ error: 'Token requis' });

  const accessToken = await getFirestoreAccessToken();
  const authHeaders = { 'Authorization': `Bearer ${accessToken}` };
  const projectId = getFirestoreProjectId();
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/signatureRequests/${token}`;

  // ── Cas refus ──
  if (decision === 'refusé') {
    try {
      const getResp = await fetch(baseUrl, { headers: authHeaders });
      if (!getResp.ok) return res.status(404).json({ error: 'Document introuvable' });
      const { fields = {} } = await getResp.json();
      const getStr = f => fields[f]?.stringValue || '';

      const patchUrl = `${baseUrl}?updateMask.fieldPaths=statut&updateMask.fieldPaths=decision&updateMask.fieldPaths=raisonRefus&updateMask.fieldPaths=commentaireRefus&updateMask.fieldPaths=dateRefus`;
      const patchResp = await fetch(patchUrl, {
        method: 'PATCH', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          statut:           { stringValue: 'refusé' },
          decision:         { stringValue: 'refusé' },
          raisonRefus:      { stringValue: raisonRefus || '' },
          commentaireRefus: { stringValue: commentaireRefus || '' },
          dateRefus:        { stringValue: new Date().toISOString() },
        }}),
      });
      if (!patchResp.ok) {
        const err = await patchResp.json();
        console.error('[submit-signature] Erreur Firestore refus:', JSON.stringify(err));
        return res.status(500).json({ error: 'Erreur sauvegarde refus : ' + (err?.error?.message || JSON.stringify(err)), details: err });
      }

      if (process.env.BREVO_API_KEY) {
        const clientNom = getStr('clientNom') || getStr('titre') || 'Client';
        const titre = getStr('titre') || 'Devis';
        const montant = getStr('montant');
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            sender: { name: 'Moustikprod CRM', email: 'contact@moustikprod.fr' },
            to: [{ email: 'contact@moustikprod.fr' }],
            subject: `❌ Devis refusé — ${clientNom} — ${titre}`,
            htmlContent: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #eee;border-radius:8px;overflow:hidden">
              <div style="background:#e53e3e;padding:24px;text-align:center"><h1 style="color:white;margin:0">❌ Devis refusé</h1></div>
              <div style="padding:30px">
                <p><strong>Client :</strong> ${clientNom}</p>
                <p><strong>Devis :</strong> ${titre}</p>
                ${montant ? `<p><strong>Montant :</strong> ${montant} €</p>` : ''}
                <p><strong>Raison :</strong> ${raisonRefus || 'Non précisée'}</p>
                <p><strong>Commentaire :</strong> ${commentaireRefus || 'Aucun'}</p>
                <p><strong>Date :</strong> ${new Date().toLocaleDateString('fr-FR')}</p>
                <hr style="margin:20px 0">
                <p style="color:#e53e3e;font-weight:bold;text-align:center">⚠️ Action requise — Recontacter ce client !</p>
                <div style="background:#fff3cd;border-radius:8px;padding:12px;margin-top:16px;text-align:center">
                  <p style="margin:0;font-size:13px;color:#856404">💪 C'est pas grave Romain, le prochain sera le bon !<br><em>— Ton CRM qui te soutient</em></p>
                </div>
              </div>
            </div>`,
          }),
        });
      }
      return res.status(200).json({ ok: true, decision: 'refusé' });
    } catch (err) {
      console.error('[submit-signature] Erreur refus:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  if (!signatureData) {
    return res.status(400).json({ error: 'Token et signature requis' });
  }

  try {
    // Lire le document existant
    const getResponse = await fetch(baseUrl, { headers: authHeaders });
    if (!getResponse.ok) return res.status(404).json({ error: 'Document introuvable' });

    const existing = await getResponse.json();
    const fields = existing.fields || {};
    const getStr = (f) => fields[f]?.stringValue || null;

    console.log('[submit-signature] Document trouvé, statut actuel:', getStr('statut'));

    // Vérifier statut
    if (getStr('statut') === 'signé') {
      return res.status(409).json({ error: 'Document déjà signé' });
    }

    // Vérifier expiration
    const expiration = getStr('dateExpiration') || getStr('expiresAt');
    if (expiration && new Date(expiration) < new Date()) {
      return res.status(410).json({ error: 'Lien expiré' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || 'inconnu';
    const dateSignature = new Date().toISOString();

    // PATCH Firestore
    let maskFields = ['statut','signatureData','dateSignature','nomSignataire','ipClient'];
    const fieldsToWrite = {
      statut:        { stringValue: 'signé' },
      signatureData: { stringValue: signatureData },
      dateSignature: { stringValue: dateSignature },
      nomSignataire: { stringValue: nomSignataire || '' },
      ipClient:      { stringValue: ip },
    };
    if (cgvAcceptees) {
      maskFields.push('cgvAcceptees', 'cgvAccepteesDate');
      fieldsToWrite.cgvAcceptees = { booleanValue: true };
      fieldsToWrite.cgvAccepteesDate = { stringValue: cgvAccepteesDate || dateSignature };
    }
    if (droitImageInclus !== undefined) {
      maskFields.push('droitImageInclus');
      fieldsToWrite.droitImageInclus = { booleanValue: !!droitImageInclus };
    }
    const patchUrl = `${baseUrl}?` + maskFields.map(f => `updateMask.fieldPaths=${f}`).join('&');

    const patchResponse = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: fieldsToWrite })
    });

    if (!patchResponse.ok) {
      const err = await patchResponse.json();
      console.error('[submit-signature] Erreur PATCH:', JSON.stringify(err).slice(0, 300));
      return res.status(500).json({ error: 'Erreur sauvegarde', details: err });
    }

    console.log('[submit-signature] Signature sauvegardée avec succès');

    // Récupérer les infos pour l'email (champs top-level)
    const clientEmail = getStr('clientEmail');
    const titre = getStr('titre') || 'votre document';
    const montant = getStr('montant') || '';
    const type = getStr('type') || 'contrat';
    const dateStr = new Date(dateSignature).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const lienSign = `https://${req.headers.host}/sign.html?token=${token}`;

    console.log('[submit-signature] Email client:', clientEmail);

    if (clientEmail && process.env.BREVO_API_KEY) {
      const emailHtml = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #eee;border-radius:8px;overflow:hidden">
          <div style="background:#024059;padding:24px;text-align:center">
            <div style="font-size:24px;font-weight:900;color:#3CD6D1;letter-spacing:-0.5px">Moustik<span style="color:#fff">Prod</span></div>
            <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px;letter-spacing:1px;text-transform:uppercase">Studio de production vidéo</div>
            <p style="color:#fff;margin:8px 0 0;font-size:14px">Studio CRM</p>
          </div>
          <div style="padding:30px">
            <h2 style="color:#024059">✅ Document signé avec succès !</h2>
            <p>Bonjour ${nomSignataire || 'Client'},</p>
            <p>Votre <strong>${type === 'devis' ? 'bon de commande' : type === 'autorisation' ? "autorisation de droit à l'image" : 'contrat'}</strong>${titre ? ' pour le projet <strong>' + titre + '</strong>' : ''} a bien été signé par les deux parties.</p>
            <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0">
              <p style="margin:0"><strong>📋 Récapitulatif :</strong></p>
              <ul style="margin:8px 0 0">
                ${titre ? `<li>Projet : ${titre}</li>` : ''}
                ${montant ? `<li>Montant HT : ${montant} €</li>` : ''}
                <li>Date de signature : ${dateStr}</li>
              </ul>
            </div>
            <p>Vous pouvez retrouver votre document signé via ce lien :</p>
            <div style="text-align:center;margin:20px 0">
              <a href="${lienSign}" style="background:#3CD6D1;color:#024059;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">📄 Voir le document signé</a>
            </div>
            <p>Merci pour votre confiance !</p>
            <p>À très bientôt,<br><strong>Romain ANDRE — Moustikprod</strong></p>
          </div>
          <div style="background:#f5f5f5;padding:15px;text-align:center;font-size:11px;color:#999">
            Moustikprod — SIRET 89033460000040 — contact@moustikprod.fr<br>
            Ce document a été signé électroniquement conformément à l'article 1367 du Code civil
          </div>
        </div>`;

      const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': process.env.BREVO_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'Moustikprod', email: 'contact@moustikprod.fr' },
          to: [{ email: clientEmail }],
          subject: `✅ Document signé — ${titre} — Moustikprod`,
          htmlContent: emailHtml,
        }),
      });

      const emailData = await emailResponse.json();
      console.log('[submit-signature] Email envoyé:', emailResponse.status, JSON.stringify(emailData).slice(0, 200));
    } else {
      console.log('[submit-signature] Email non envoyé —', !clientEmail ? 'pas d\'email client' : 'clé Brevo manquante');
    }

    res.status(200).json({ ok: true, dateSignature });

  } catch (err) {
    console.error('[submit-signature] Erreur globale:', err.message);
    res.status(500).json({ error: err.message });
  }
}
