import { requireUser } from './_verifyAuth.js';
import { readGoogleAuth, writeGoogleAuth } from './_lib/google-store.js';
import { getAccessToken, getFirestoreProjectId, fromFirestoreFields, toFirestoreFields } from './_lib/firestore-admin.js';
import { getUserAccessToken, ensureDedicatedCalendar, insertEvent, patchEvent, listCalendars, listCalendarEventsGoogle } from './_lib/gcal.js';

// Synchro Studio ↔ Google Calendar (T4). Fonction STATIQUE + rewrite
// /api/calendar/:action → /api/calendar?action=:action (comme api/google.js),
// pour rester sous la limite de 12 fonctions du plan Hobby.
export default async function handler(req, res) {
  switch (req.query.action) {
    case 'sync': return handleSync(req, res);
    default:     return res.status(404).json({ error: 'Action calendrier inconnue' });
  }
}

const FS_BASE = (projectId) => `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

// Liste tous les calendarEvents de l'utilisateur (Admin SDK, avec pagination).
async function listCalendarEvents(fsToken, projectId, uid) {
  const out = [];
  let pageToken = '';
  do {
    const url = `${FS_BASE(projectId)}/users/${uid}/calendarEvents?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${fsToken}` } });
    if (!res.ok) throw new Error(`Lecture calendarEvents échouée (${res.status})`);
    const data = await res.json();
    for (const d of (data.documents || [])) out.push(fromFirestoreFields(d.fields || {}));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Met à jour quelques champs d'un calendarEvent (googleEventId/syncStatus/…)
// sans écraser le reste du document (updateMask indispensable).
async function patchCalendarEvent(fsToken, projectId, uid, id, fieldsObj) {
  const mask = Object.keys(fieldsObj).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const url = `${FS_BASE(projectId)}/users/${uid}/calendarEvents/${id}?${mask}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${fsToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(fieldsObj) }),
  });
  if (!res.ok) throw new Error(`Écriture calendarEvent échouée (${res.status})`);
}

async function handleSync(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireUser(req, res);
  if (!user) return;
  const uid = user.localId;

  try {
    // 1. Doc googleAuth (serveur-only) → refresh token.
    const auth = await readGoogleAuth(uid);
    if (!auth || !auth.refreshToken) {
      return res.status(400).json({ error: 'not_connected', message: 'Google Calendar non connecté.' });
    }

    // 2. Access token dérivé (jamais stocké). Échec = token révoqué/expiré.
    let accessToken;
    try {
      accessToken = await getUserAccessToken(auth.refreshToken);
    } catch (e) {
      return res.status(401).json({ error: 'reauth', message: 'Reconnecte Google Calendar (accès expiré ou révoqué).' });
    }

    // 3. Agenda dédié « Moustikprod » — idempotent. Ne persiste l'id QUE si un
    //    nouvel agenda a réellement été créé.
    let calendarId;
    try {
      const r = await ensureDedicatedCalendar(accessToken, auth.dedicatedCalendarId || null);
      calendarId = r.calendarId;
      if (r.created) await writeGoogleAuth(uid, { dedicatedCalendarId: calendarId }, ['dedicatedCalendarId']);
    } catch (e) {
      return res.status(502).json({ error: 'calendar', message: 'Impossible de créer ou d\'accéder à l\'agenda dédié.' });
    }

    // 4. Lire les calendarEvents du Studio (Admin SDK).
    const fsToken = await getAccessToken();
    const projectId = getFirestoreProjectId();
    const events = await listCalendarEvents(fsToken, projectId, uid);

    // 5. Push Studio → Google. Erreurs ISOLÉES par événement : un échec passe le
    //    doc en syncStatus:'error' sans bloquer les autres. Idempotent : un event
    //    déjà 'synced' avec googleEventId est sauté (re-sync sans changement = 0 écriture).
    let pushed = 0, updated = 0, failed = 0;
    const now = () => new Date().toISOString();

    for (const ev of events) {
      if (ev.syncStatus === 'synced' && ev.googleEventId) continue;
      try {
        if (!ev.googleEventId) {
          const gid = await insertEvent(accessToken, calendarId, ev);
          await patchCalendarEvent(fsToken, projectId, uid, ev.id, { googleEventId: gid, syncStatus: 'synced', syncError: null, updatedAt: now() });
          pushed++;
        } else {
          let recreated = false;
          try {
            await patchEvent(accessToken, calendarId, ev.googleEventId, ev);
          } catch (pe) {
            if (pe.status === 404) {
              // Event supprimé côté Google → on le recrée (nouvel id).
              const gid = await insertEvent(accessToken, calendarId, ev);
              await patchCalendarEvent(fsToken, projectId, uid, ev.id, { googleEventId: gid, syncStatus: 'synced', syncError: null, updatedAt: now() });
              pushed++;
              recreated = true;
            } else {
              throw pe;
            }
          }
          if (!recreated) {
            await patchCalendarEvent(fsToken, projectId, uid, ev.id, { syncStatus: 'synced', syncError: null, updatedAt: now() });
            updated++;
          }
        }
      } catch (e) {
        failed++;
        try {
          await patchCalendarEvent(fsToken, projectId, uid, ev.id, {
            syncStatus: 'error',
            syncError: String((e && e.message) || 'erreur').slice(0, 300),
            updatedAt: now(),
          });
        } catch (_) { /* on n'aggrave pas un échec par un autre */ }
      }
    }

    // 6. Lecture Google → Studio : TOUS les agendas (Keolis/perso/…) sur 3 mois
    //    glissants, en lecture seule, avec la couleur de chaque agenda. On EXCLUT
    //    l'agenda dédié (ses events sont déjà rendus via les calendarEvents Studio,
    //    sinon doublon). Best-effort : un agenda en échec n'invalide pas le reste.
    let googleEvents = [], readCalendars = [], importError = false;
    try {
      const d = new Date();
      const timeMin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
      const timeMax = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1)).toISOString();
      const calendars = await listCalendars(accessToken);
      for (const cal of calendars) {
        if (cal.id === calendarId) continue; // agenda dédié : ne pas ré-afficher
        readCalendars.push({ id: cal.id, summary: cal.summary, backgroundColor: cal.backgroundColor, foregroundColor: cal.foregroundColor });
        try {
          const items = await listCalendarEventsGoogle(accessToken, cal.id, timeMin, timeMax);
          for (const it of items) {
            googleEvents.push({ ...it, calendarId: cal.id, calendarSummary: cal.summary, backgroundColor: cal.backgroundColor, foregroundColor: cal.foregroundColor });
          }
        } catch (_) { /* cet agenda échoue → on continue avec les autres */ }
      }
    } catch (e) {
      importError = true; // échec de la liste des agendas elle-même
    }

    // 7. lastSyncAt.
    const lastSyncAt = now();
    try { await writeGoogleAuth(uid, { lastSyncAt }, ['lastSyncAt']); } catch (_) { /* non bloquant */ }

    // 8. Réponse (le refresh token ne quitte jamais le serveur).
    return res.status(200).json({ pushed, updated, failed, imported: googleEvents.length, importError, googleEvents, calendars: readCalendars, calendarId, lastSyncAt });
  } catch (e) {
    return res.status(500).json({ error: 'sync_failed', message: (e && e.message) || 'Erreur de synchronisation.' });
  }
}
