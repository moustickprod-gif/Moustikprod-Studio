// ⚠️ ROUTE TEMPORAIRE — à supprimer juste après usage.
// Sert uniquement à identifier le format réel du champ `type` renvoyé par
// l'API Abby (texte type "service_delivery" vs numérique) avant d'implémenter
// le champ "type d'article" côté catalogue/devis. Lecture seule (GET), aucune
// écriture sur le compte Abby.
//
// Protégée par un paramètre `secret` en dur (route temporaire, courte durée
// de vie — pas d'ajout de variable d'env pour un usage aussi éphémère).
const DEBUG_SECRET = '0beadc54f9cc6aff162f28815b160ed0';

const BASE = 'https://api.app-abby.com';
const ABBY_KEY = process.env.ABBY_API_KEY || process.env.Moustikprod_Studio;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (req.query.secret !== DEBUG_SECRET) return res.status(404).json({ error: 'Not found' });
  if (!ABBY_KEY) return res.status(500).json({ error: 'Clé Abby non configurée' });

  try {
    const catalogRes = await fetch(`${BASE}/v2/catalog?page=1&limit=20`, {
      headers: { 'Authorization': `Bearer ${ABBY_KEY}` },
    });
    const catalogRaw = await catalogRes.json();
    const products = catalogRaw?.docs || catalogRaw?.data || (Array.isArray(catalogRaw) ? catalogRaw : []);

    // On ne renvoie QUE ce qui est utile au diagnostic : jamais la clé, jamais
    // les données client/prix complètes — juste id + désignation tronquée +
    // le champ type et son typeof, pour trancher texte vs numérique.
    const catalogTypes = products.map(p => ({
      id: p.id,
      designation: String(p.designation || '').slice(0, 40),
      type: p.type,
      typeOf: typeof p.type,
    }));

    res.status(200).json({
      ok: true,
      catalogHttpStatus: catalogRes.status,
      catalogItemsFound: products.length,
      catalogTypes,
      note: catalogTypes.length === 0
        ? 'Catalogue Abby vide ou format de réponse inattendu — voir catalogHttpStatus.'
        : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
