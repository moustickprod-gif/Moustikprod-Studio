// Appels Google Calendar API — serveur-only (T4).
// L'access token est DÉRIVÉ du refresh token à chaque sync, jamais stocké.

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

// Dérive un access token utilisateur à partir du refresh token (serveur-only).
export async function getUserAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Config OAuth Google manquante');
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const e = new Error('REFRESH_FAILED');
    e.detail = data;
    throw e;
  }
  return data.access_token;
}

async function calFetch(accessToken, path, options = {}) {
  return fetch(`${CAL_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

// IDEMPOTENT — critique : ne doit JAMAIS créer un 2e agenda « Moustikprod ».
// Si `existingId` est fourni ET pointe vers un agenda encore présent → on le
// réutilise tel quel (aucune création). On ne crée un agenda QUE si `existingId`
// est absent, ou s'il pointe vers un agenda supprimé côté Google (404).
// Renvoie { calendarId, created } — created=true seulement si un NOUVEL agenda
// a été créé, pour que l'appelant persiste le nouvel id.
export async function ensureDedicatedCalendar(accessToken, existingId) {
  if (existingId) {
    const check = await calFetch(accessToken, `/calendars/${encodeURIComponent(existingId)}`);
    if (check.ok) return { calendarId: existingId, created: false };
    if (check.status !== 404) {
      const e = new Error('CALENDAR_CHECK_FAILED');
      e.detail = await check.json().catch(() => ({}));
      throw e;
    }
    // 404 → l'agenda stocké a été supprimé côté Google : on en recrée un.
  }
  const res = await calFetch(accessToken, '/calendars', {
    method: 'POST',
    body: JSON.stringify({
      summary: 'Moustikprod',
      description: 'Tournages, relances et deadlines — synchronisés depuis Moustikprod Studio.',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const e = new Error('CALENDAR_CREATE_FAILED');
    e.detail = data;
    throw e;
  }
  return { calendarId: data.id, created: true };
}

// Événement all-day. Google : end.date est EXCLUSIF, donc pour un event du jour
// J (ou J→endDate) on met end.date = lendemain de la date de fin.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Décale hh:mm de `hours` heures en gérant le passage minuit (pour l'end +1h
// par défaut). Renvoie le jour éventuellement incrémenté + l'heure.
function shiftHour(day, hhmm, hours) {
  let [h, m] = hhmm.split(':').map(Number);
  h += hours;
  let d = day;
  while (h >= 24) { h -= 24; d = addDays(d, 1); }
  return { day: d, time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
}

const TZ = 'Europe/Paris';

// Événement Google. Deux formats mutuellement exclusifs selon la présence d'une
// heure de début :
// - TIMED (startTime) : start.dateTime/end.dateTime SANS offset + timeZone
//   Europe/Paris → Google interprète l'heure comme heure locale (aucune dérive
//   UTC, on ne passe pas par un Date JS). Fin = endTime, sinon défaut +1h.
// - ALL-DAY (pas de startTime) : start.date/end.date, end exclusif = lendemain.
// patchEvent envoie toujours l'objet start/end COMPLET → le patch remplace
// l'objet entier, donc la bascule all-day <-> timed d'un event déjà poussé se
// fait sans erreur « both date and dateTime » et en conservant le googleEventId.
function toGoogleEvent(ev) {
  const day = (ev.date || '').slice(0, 10);
  const endDay = (ev.endDate || ev.date || '').slice(0, 10);
  const base = {
    summary: ev.title || 'Événement',
    description: ev.notes || '',
    extendedProperties: { private: { moustikprodEventId: String(ev.id || ''), moustikprodType: String(ev.type || '') } },
  };
  if (ev.startTime) {
    const st = String(ev.startTime).slice(0, 5);
    let endStr;
    if (ev.endTime) {
      endStr = `${endDay}T${String(ev.endTime).slice(0, 5)}:00`;
    } else {
      const e = shiftHour(day, st, 1); // défaut +1h
      endStr = `${e.day}T${e.time}:00`;
    }
    base.start = { dateTime: `${day}T${st}:00`, timeZone: TZ };
    base.end = { dateTime: endStr, timeZone: TZ };
  } else {
    base.start = { date: day };
    base.end = { date: addDays(endDay, 1) };
  }
  return base;
}

export async function insertEvent(accessToken, calendarId, ev) {
  const res = await calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(toGoogleEvent(ev)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const e = new Error('EVENT_INSERT_FAILED');
    e.detail = data;
    e.status = res.status;
    throw e;
  }
  return data.id;
}

export async function patchEvent(accessToken, calendarId, googleEventId, ev) {
  const res = await calFetch(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
    { method: 'PATCH', body: JSON.stringify(toGoogleEvent(ev)) }
  );
  if (res.status === 404) {
    const e = new Error('EVENT_NOT_FOUND');
    e.status = 404;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('EVENT_PATCH_FAILED');
    e.detail = data;
    e.status = res.status;
    throw e;
  }
  return data.id || googleEventId;
}

// Supprime un événement dans l'agenda `calendarId`. L'appelant garantit que
// calendarId est l'agenda dédié (jamais primary). 404/410 = l'événement n'existe
// déjà plus → succès (objectif atteint), pas une erreur.
export async function deleteEvent(accessToken, calendarId, googleEventId) {
  const res = await calFetch(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
    { method: 'DELETE' }
  );
  if (res.ok || res.status === 404 || res.status === 410) return { ok: true };
  const detail = await res.json().catch(() => ({}));
  const e = new Error('EVENT_DELETE_FAILED');
  e.status = res.status;
  e.detail = detail;
  throw e;
}

// Liste TOUS les agendas de l'utilisateur (lecture seule) avec leur couleur.
// backgroundColor/foregroundColor permettent de distinguer visuellement
// Keolis / perso / Moustikprod dans la vue Studio.
export async function listCalendars(accessToken) {
  const res = await calFetch(accessToken, '/users/me/calendarList?minAccessRole=reader&maxResults=250');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('CALENDAR_LIST_FAILED');
    e.detail = data;
    throw e;
  }
  return (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary || c.id,
    backgroundColor: c.backgroundColor || null,
    foregroundColor: c.foregroundColor || null,
    primary: !!c.primary,
  }));
}

// Lecture seule des événements d'UN agenda sur [timeMin, timeMax).
// L'appelant gère le best-effort (un agenda en échec n'empêche pas les autres).
export async function listCalendarEventsGoogle(accessToken, calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const res = await calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('EVENTS_LIST_FAILED');
    e.detail = data;
    e.status = res.status;
    throw e;
  }
  return (data.items || []).map((it) => ({
    id: it.id,
    title: it.summary || '(sans titre)',
    start: (it.start && (it.start.date || it.start.dateTime)) || null,
    end: (it.end && (it.end.date || it.end.dateTime)) || null,
    allDay: !!(it.start && it.start.date),
  }));
}
