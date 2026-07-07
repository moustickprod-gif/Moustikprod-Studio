# 🦟 Moustikprod Studio — app unifiée

Fusion du CRM et de Studio en une seule application, centrée sur la **création** et le **suivi de production**. La gestion financière (devis, factures, contrats, trésorerie, TVA, URSSAF) est déléguée à **Abby** (https://app.abby.fr).

## Modules

| Module | Origine |
|---|---|
| Dashboard, Projets (pitch/scénario/découpage/logistique/captions/suivi) | Studio |
| Studio IA (script, shot list, idées, captions, interview, email) | Studio |
| Idées & veille (hebdo auto + à la demande) | Studio |
| Clients (partagés Firestore) | Studio |
| **Calendrier** (deadlines, tournages, expirations signature) | nouveau |
| **Droit à l'image + signature électronique** (`sign.html`) | porté du CRM |
| Partage projet client (`share.html`) | Studio |

## Sécurité (corrigée lors de la fusion)

- **Tous** les endpoints API exigent un token Firebase (`api/_verifyAuth.js`) + filtre `ALLOWED_EMAILS`.
- Proxy Notion : endpoints en **liste blanche** (plus d'accès workspace complet).
- `send-email` authentifié (plus de relais spam Brevo).
- `signatureRequests` verrouillée côté règles Firestore — créée/lue uniquement via `/api/signature` (compte de service).
- CORS `*` supprimé partout (same-origin).

## Variables d'environnement (Vercel)

Voir `.env.local.example`. **Obligatoires** : `ALLOWED_EMAILS`, `ANTHROPIC_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_KEY`.
Optionnelles : `NOTION_TOKEN` (export Notion), `BREVO_API_KEY` (emails de signature), `IDEAS_INGEST_SECRET` + `STUDIO_OWNER_EMAIL` (tâche hebdo idées).

## Déploiement

```
vercel --prod
```
Puis déployer les règles Firestore : `firebase deploy --only firestore:rules`.

## Migration depuis le CRM

- Clients et projets : déjà partagés (mêmes collections Firestore) — rien à faire.
- Autorisations droit à l'image : l'ancien format blob (`autorisations/items`) est **migré automatiquement** au premier chargement vers un document par autorisation.
- Devis/factures/contrats/trésorerie : à reprendre dans Abby ; l'ancien CRM reste consultable tant qu'il n'est pas supprimé.
