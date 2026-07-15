// ⚠️ ROUTE TEMPORAIRE — à supprimer juste après usage.
// Sert uniquement à identifier le format réel du champ `type` renvoyé par
// l'API Abby (texte type "service_delivery" vs numérique) sur les lignes
// d'un devis/facture existant, avant d'implémenter le champ "type d'article"
// côté catalogue/devis. Lecture seule (GET), aucune écriture sur le compte
// Abby. La doc publique ne documente pas d'endpoint GET pour lister/lire les
// devis/factures existants (seulement création + PATCH lignes) — cette route
// sonde plusieurs chemins candidats et rapporte ce qui répond.
//
// Protégée par un paramètre `secret` en dur (route temporaire, courte durée
// de vie — pas d'ajout de variable d'env pour un usage aussi éphémère).
const DEBUG_SECRET = '0beadc54f9cc6aff162f28815b160ed0';

const BASE = 'https://api.app-abby.com';
const ABBY_KEY = process.env.ABBY_API_KEY || process.env.Moustikprod_Studio;

async function abbyGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${ABBY_KEY}` },
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* pas de body JSON */ }
  return { status: res.status, ok: res.ok, data };
}

function extractDocs(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.docs)) return data.docs;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

// Jamais de montant/coordonnées client — juste ce qu'il faut pour identifier
// le document et trancher texte vs numérique sur le champ type des lignes.
function summarizeLines(lines) {
  return (Array.isArray(lines) ? lines : []).map(l => ({
    designation: String(l.designation || '').slice(0, 40),
    type: l.type,
    typeOf: typeof l.type,
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (req.query.secret !== DEBUG_SECRET) return res.status(404).json({ error: 'Not found' });
  if (!ABBY_KEY) return res.status(500).json({ error: 'Clé Abby non configurée' });

  try {
    // 1) On sonde plusieurs chemins de LISTE candidats en parallèle pour
    // trouver celui qui répond avec de vrais documents.
    const listCandidates = [
      '/v2/billing?page=1&limit=50',
      '/v2/billings?page=1&limit=50',
      '/v2/billing/estimate?page=1&limit=50',
      '/v2/billing/estimates?page=1&limit=50',
      '/v2/quote?page=1&limit=50',
      '/v2/quotes?page=1&limit=50',
      '/v2/invoicing?page=1&limit=50',
    ];
    const listResults = await Promise.all(listCandidates.map(async (path) => {
      const r = await abbyGet(path);
      return { path, status: r.status, itemsFound: extractDocs(r.data).length, docs: extractDocs(r.data) };
    }));
    const listProbe = listResults.map(({ path, status, itemsFound }) => ({ path, status, itemsFound }));
    const working = listResults.find(r => r.status === 200 && r.itemsFound > 0);
    const foundDocs = working ? working.docs : [];

    const docsSummary = foundDocs.slice(0, 10).map(d => ({
      id: d.id,
      number: d.number,
      state: d.state || d.status,
      docType: d.estimateType || d.type,
    }));

    // 2) Pour les 3 premiers documents trouvés, on sonde plusieurs chemins de
    // DÉTAIL candidats jusqu'à en trouver un qui renvoie les lignes.
    const detailCandidatesFor = (id) => [
      `/v2/billing/${id}`,
      `/v2/billing/estimate/${id}`,
      `/v2/billing/invoice/${id}`,
      `/v2/quote/${id}`,
    ];
    const detailResults = [];
    for (const d of foundDocs.slice(0, 3)) {
      if (!d.id) continue;
      for (const path of detailCandidatesFor(d.id)) {
        const r = await abbyGet(path);
        if (r.ok && r.data) {
          detailResults.push({
            billingId: d.id,
            workingDetailPath: path,
            status: r.status,
            state: r.data.state || r.data.status,
            lines: summarizeLines(r.data.lines),
          });
          break;
        }
      }
    }

    // 3) Catalogue produits, en complément (déjà testé précédemment).
    const catalog = await abbyGet('/v2/catalog?page=1&limit=20');
    const catalogTypes = extractDocs(catalog.data).map(p => ({
      designation: String(p.designation || '').slice(0, 40),
      type: p.type,
      typeOf: typeof p.type,
    }));

    res.status(200).json({
      ok: true,
      listProbe,
      workingListPath: working ? working.path : null,
      docsSummary,
      detailResults,
      catalogHttpStatus: catalog.status,
      catalogTypes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
