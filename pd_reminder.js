/**
 * PD 7-Day Reminder
 *
 * Daily run: find PD sessions ~7 days out on the watched calendar(s), read the
 * attendee list, and create a DRAFT reminder (Zoom link, date, time, invite for
 * questions) for a human to review and send. Does not send anything itself.
 *
 * Double-send guard: the draft itself is the marker. Before drafting for an
 * event, we search existing drafts for that event's ID (stamped in a header).
 * If one exists, we skip. Idempotent across daily runs with no separate store.
 *
 * Config-driven so sender + watched calendars change without touching logic.
 */

const CONFIG = {
  SENDER_EMAIL: 'shmog@wallwisher.com',
  WATCHED_CALENDARS: [
    'elledub@wallwisher.com'
    // add more PD owners here later
  ],
  // Draft a reminder when a PD is between LEAD_MIN and LEAD_MAX days out.
  // The daily run + draft-existence guard means it's drafted once, on the first
  // run that sees the PD land in this window.
  LEAD_MIN_DAYS: 7,
  LEAD_MAX_DAYS: 8,
  TITLE_MATCH: 'padlet pd',
  TITLE_BLOCKLIST: ['yoga', 'edu collab'],
  INTERNAL_DOMAIN: 'wallwisher.com',
  MODE: 'draft'   // 'draft' = create Gmail drafts (current). 'send' = send live.
};

/**
 * Exchange the long-lived refresh token for a fresh access token.
 * Runs on every invocation; access tokens last ~1h, refresh token is durable.
 * Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in env.
 */
async function getGoogleToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Google token exchange failed: ' + JSON.stringify(data));
  }
  return data.access_token;
}

function isPdEvent(ev) {
  const title = (ev.summary || '').toLowerCase().trim();
  if (!title) return false;
  if (CONFIG.TITLE_BLOCKLIST.some((b) => title.includes(b))) return false;
  return title.includes(CONFIG.TITLE_MATCH);
}

function attendeesToRemind(ev) {
  const seen = new Set();
  const out = [];
  for (const a of ev.attendees || []) {
    if (!a.email || a.resource || a.self) continue;
    if (a.responseStatus === 'declined') continue;
    const email = a.email.toLowerCase();
    if (email.endsWith(`@${CONFIG.INTERNAL_DOMAIN}`)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: a.displayName || '' });
  }
  return out;
}

function zoomLink(ev) {
  if (ev.location && /zoom\.us/.test(ev.location)) return ev.location.trim();
  const m = (ev.description || '').match(/https:\/\/[a-z0-9.-]*zoom\.us\/j\/\d+[^\s]*/i);
  return m ? m[0] : '';
}

async function listEvents(token, calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '50'
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Calendar ${calendarId} ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const items = j.items || [];
  console.log(`[cal ${calendarId}] window ${timeMin} .. ${timeMax} -> ${items.length} raw events`);
  for (const ev of items) {
    console.log(`   - "${ev.summary}" @ ${ev.start && (ev.start.dateTime || ev.start.date)}`);
  }
  return items;
}

/**
 * Double-send guard. Each draft carries a header  X-PD-Reminder: <eventId>.
 * Gmail indexes raw headers, so we can find prior drafts by searching for the
 * event ID. Returns true if a reminder draft for this event already exists.
 */
/**
 * Double-send guard. Each draft carries  X-PD-Reminder: <eventId>.
 * Uses the drafts.list endpoint (permitted by gmail.compose) with a q filter,
 * rather than messages.list (which needs a broader read scope). Returns true
 * if a reminder draft for this event already exists.
 */
async function reminderAlreadyExists(token, eventId) {
  const q = encodeURIComponent(`"X-PD-Reminder: ${eventId}"`);
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts?q=${q}&maxResults=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Gmail drafts.list ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return (j.drafts && j.drafts.length > 0) || false;
}

function buildMime(ev, recipients) {
  const start = new Date(ev.start.dateTime || ev.start.date);
  const when = start.toLocaleString('en-US', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Los_Angeles'
  });
  const link = zoomLink(ev);

  const subject = 'Reminder: your Padlet PD session is in one week';
  const body = [
    'Hi there,',
    '',
    'This is a friendly reminder that your Padlet professional development session is one week away.',
    '',
    `Date and time: ${when} (Pacific)`,
    link ? `Zoom link: ${link}` : '',
    '',
    'If you have any questions or anything specific you would like us to cover, just reply to this email and let us know.',
    '',
    'See you soon,',
    'The Padlet PD team'
  ].filter((l) => l !== '').join('\r\n');

  const mime = [
    `From: ${CONFIG.SENDER_EMAIL}`,
    `To: ${CONFIG.SENDER_EMAIL}`,
    `Bcc: ${recipients.map((r) => r.email).join(', ')}`,
    `Reply-To: ${CONFIG.SENDER_EMAIL}`,
    `Subject: ${subject}`,
    `X-PD-Reminder: ${ev.id}`,          // guard marker
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body
  ].join('\r\n');

  return mime;
}

async function createDraft(token, mime) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw: Buffer.from(mime).toString('base64url') } })
  });
  if (!res.ok) throw new Error(`Gmail draft ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const token = await getGoogleToken();
  // Whole-day window: catch anything landing on calendar-days 7 and 8 ahead,
  // regardless of what time the job runs. Anchor to UTC midnight so a late-day
  // run doesn't push the window past a morning event (which dropped the Aug 26
  // PDs when the boundary was a raw now+7*24h).
  const midnightUtc = new Date();
  midnightUtc.setUTCHours(0, 0, 0, 0);
  const base = midnightUtc.getTime();
  const timeMin = new Date(base + CONFIG.LEAD_MIN_DAYS * 86400000).toISOString();
  const timeMax = new Date(base + (CONFIG.LEAD_MAX_DAYS + 1) * 86400000).toISOString();

  const summary = { detected: 0, drafted: 0, skippedExisting: 0, skippedNoAttendees: 0 };

  for (const cal of CONFIG.WATCHED_CALENDARS) {
    for (const ev of await listEvents(token, cal, timeMin, timeMax)) {
      if (!isPdEvent(ev)) continue;
      summary.detected++;

      if (await reminderAlreadyExists(token, ev.id)) {
        summary.skippedExisting++;
        console.log(`[skip] draft already exists: "${ev.summary}"`);
        continue;
      }

      const recipients = attendeesToRemind(ev);
      if (!recipients.length) {
        summary.skippedNoAttendees++;
        console.log(`[skip] no external attendees: "${ev.summary}"`);
        continue;
      }

      const mime = buildMime(ev, recipients);
      await createDraft(token, mime);
      summary.drafted++;
      console.log(`[draft] "${ev.summary}" -> ${recipients.map((r) => r.email).join(', ')}`);
    }
  }
  console.log('\n=== summary ===\n' + JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { isPdEvent, attendeesToRemind, zoomLink, buildMime };