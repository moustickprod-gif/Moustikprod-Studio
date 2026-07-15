// ⚠️ ROUTE TEMPORAIRE — ÉCRIT RÉELLEMENT DANS LE COMPTE ABBY. À supprimer
// juste après usage.
// La lecture des devis/factures existants s'est révélée impossible (tous les
// endpoints GET candidats renvoient 404/400 — pas de GET documenté ni trouvé
// pour /v2/billing). On teste donc en écriture : crée un contact fictif +
// un devis minimal à une ligne, en tentant `type: "service_delivery"`
// (texte), puis si rejeté `type: 1` (numérique), pour voir lequel Abby
// accepte et sous quelle forme il le restitue.
//
// Protégée par secret + confirm en dur (route temporaire à usage unique/rare
// — pas d'ajout de variable d'env). Nouveau secret, distinct de l'ancienne
// route en lecture seule.
const DEBUG_SECRET = '31060eb2cde290f21b0a767c89e5a6a1';

const BASE = 'https://api.app-abby.com';
const ABBY_KEY = process.env.ABBY_API_KEY || process.env.Moustikprod_Studio;

async function abby(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${ABBY_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* pas de body JSON */ }
  return { status: res.status, ok: res.ok, data };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (req.query.secret !== DEBUG_SECRET || req.query.confirm !== 'yes') {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!ABBY_KEY) return res.status(500).json({ error: 'Clé Abby non configurée' });

  const report = { steps: [] };
  // Tout ID créé pendant l'exécution est tracé ici au fur et à mesure, pour
  // que la section "aSupprimer" reste exacte même si l'exécution s'arrête en
  // cours de route (échec d'une étape).
  const created = { contacts: [], estimates: [] };
  const finish = (extra) => {
    report.aSupprimer = {
      ...created,
      commentSupprimer: {
        contacts: "DELETE /contact/{id} probable (non confirmé) — un outil MCP \"delete-contact\" existe côté Abby, mais échoue si le contact a des documents de facturation liés (ce sera le cas ici À CAUSE du devis de test) : il faudra donc supprimer le devis d'abord, ou utiliser l'archivage.",
        estimates: "Pas de suppression via l'API trouvée pour les devis — seulement un archivage (\"archive-billing\", masque sans supprimer). Suppression réelle probablement seulement possible à la main dans app.abby.fr.",
      },
    };
    return res.status(200).json({ ...report, ...extra });
  };

  try {
    // 1) Contact fictif, clairement identifiable pour suppression manuelle.
    const contact = await abby('POST', '/contact', {
      firstname: 'TEST DEBUG',
      lastname: 'A SUPPRIMER — type article',
    });
    report.steps.push({ step: 'createContact', status: contact.status, ok: contact.ok, body: contact.data });
    if (!contact.ok || !contact.data?.id) {
      return finish({ error: 'Échec création du contact de test — arrêt.' });
    }
    const customerId = contact.data.id;
    report.testContactId = customerId;
    created.contacts.push(customerId);

    // 2) Devis minimal pour ce contact.
    const estimate = await abby('POST', `/v2/billing/estimate/${encodeURIComponent(customerId)}`, { estimateType: 'estimate' });
    report.steps.push({ step: 'createEstimate', status: estimate.status, ok: estimate.ok, body: estimate.data });
    if (!estimate.ok || !estimate.data?.id) {
      return finish({ error: 'Échec création du devis de test — arrêt.' });
    }
    const billingId = estimate.data.id;
    report.testEstimateId = billingId;
    created.estimates.push(billingId);

    // 3) Ligne avec type texte "service_delivery".
    const lineTextBody = {
      lines: [{
        designation: 'TEST DEBUG — à supprimer (ligne format type article)',
        quantity: 1,
        unitPrice: 100,
        vatCode: 'FR_00HT',
        type: 'service_delivery',
      }],
    };
    const attemptText = await abby('PATCH', `/v2/billing/${encodeURIComponent(billingId)}/lines`, lineTextBody);
    report.steps.push({ step: 'setLines type="service_delivery" (texte)', status: attemptText.status, ok: attemptText.ok, body: attemptText.data });

    if (attemptText.ok) {
      report.result = 'FORMAT TEXTE ACCEPTÉ';
      report.lineTypeAsStoredByAbby = attemptText.data?.lines?.[0]?.type;
      report.lineTypeOf = typeof attemptText.data?.lines?.[0]?.type;
      return finish();
    }

    // 4) Sinon, tentative avec type numérique 1.
    const lineNumBody = {
      lines: [{
        designation: 'TEST DEBUG — à supprimer (ligne format type article, essai numérique)',
        quantity: 1,
        unitPrice: 100,
        vatCode: 'FR_00HT',
        type: 1,
      }],
    };
    const attemptNum = await abby('PATCH', `/v2/billing/${encodeURIComponent(billingId)}/lines`, lineNumBody);
    report.steps.push({ step: 'setLines type=1 (numérique)', status: attemptNum.status, ok: attemptNum.ok, body: attemptNum.data });

    if (attemptNum.ok) {
      report.result = 'FORMAT NUMÉRIQUE ACCEPTÉ';
      report.lineTypeAsStoredByAbby = attemptNum.data?.lines?.[0]?.type;
      report.lineTypeOf = typeof attemptNum.data?.lines?.[0]?.type;
    } else {
      report.result = 'AUCUN DES DEUX FORMATS ACCEPTÉ — voir messages d\'erreur exacts dans steps[].body';
    }

    return finish();
  } catch (err) {
    report.error = err.message;
    return finish();
  }
}
