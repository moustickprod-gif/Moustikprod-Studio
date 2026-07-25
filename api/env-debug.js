// ⚠️ ROUTE DE DEBUG TEMPORAIRE — À SUPPRIMER après diagnostic.
// Ne renvoie JAMAIS la valeur d'un secret : uniquement des métadonnées
// (présence, longueur, si ça commence par '{', si c'est le texte "undefined").
// Objectif : savoir si FIREBASE_SERVICE_ACCOUNT_KEY est ABSENTE ou MALFORMÉE
// dans le scope Preview, sans jamais exposer la clé du compte de service.
export default function handler(req, res) {
  const meta = (name) => {
    const v = process.env[name];
    if (v === undefined) return { present: false };
    return {
      present: true,
      length: v.length,
      startsWithBrace: v.trimStart().startsWith('{'),
      isLiteralUndefined: v === 'undefined',
      isEmpty: v.length === 0,
    };
  };
  res.status(200).json({
    note: 'route de debug temporaire — aucune valeur de secret exposée',
    vercelEnv: process.env.VERCEL_ENV || null, // 'production' | 'preview' | 'development'
    vercelBranch: process.env.VERCEL_GIT_COMMIT_REF || null,
    FIREBASE_SERVICE_ACCOUNT_KEY: meta('FIREBASE_SERVICE_ACCOUNT_KEY'),
    STUDIO_OWNER_EMAIL: meta('STUDIO_OWNER_EMAIL'),
    FIREBASE_API_KEY: meta('FIREBASE_API_KEY'),
    ANTHROPIC_API_KEY: meta('ANTHROPIC_API_KEY'),
  });
}
