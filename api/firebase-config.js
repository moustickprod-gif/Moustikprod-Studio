// Studio partage le projet Firebase du CRM (mêmes comptes, mêmes données
// clients/projets en sous-collections Firestore — voir index.html ligne ~899).
// Ces valeurs par défaut reprennent la config en dur du CRM (Desktop/CRM-Moustikprod/index.html)
// pour que la sync fonctionne même si les variables d'env Vercel ne sont pas définies sur ce projet.
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyBGFGecF81Pj_JfAmYTHeWFL8uYr3U1noY',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'moustikprod-crm.firebaseapp.com',
    projectId: process.env.FIREBASE_PROJECT_ID || 'moustikprod-crm'
  });
}
