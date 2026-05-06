/**
 * gcal.js — Google Calendar 연동 (googleapis 패키지 없이 Node.js 내장 https만 사용)
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { shell, app } = require('electron');

// ── Plain-file storage (no encryption — personal desktop app) ─────────────
let _gcalDataPath = null;
function gcalDataPath() {
  if (!_gcalDataPath) {
    _gcalDataPath = path.join(app.getPath('userData'), 'gcal-data.json');
  }
  return _gcalDataPath;
}
function loadGcalData() {
  try {
    const p = gcalDataPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {}
  return {};
}
function saveGcalData(data) {
  try { fs.writeFileSync(gcalDataPath(), JSON.stringify(data, null, 2)); }
  catch (e) { console.error('gcal-data save error:', e.message); }
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'openid', 'email', 'profile',
].join(' ');

const REDIRECT_URI = 'http://localhost:3000';
const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// ── Storage helpers ───────────────────────────────────────────────────────
function getStoredTokens()  { return loadGcalData().tokens || null; }
function saveTokens(t)      {
  const d = loadGcalData();
  d.tokens = t;
  // Tag tokens with the client_id that issued them so we can detect
  // when the OAuth client changes (e.g. project migration) and force re-auth.
  const cfg = loadConfig();
  if (cfg.client_id) d.authClientId = cfg.client_id;
  saveGcalData(d);
}

// If the stored tokens were issued by a different OAuth client than the one
// currently configured (e.g. user upgraded to v2 with a new Firebase project),
// clear them so the next authenticate call issues fresh tokens with the
// correct audience.
function invalidateStaleTokens() {
  const d = loadGcalData();
  if (!d.tokens) return;
  const cfg = loadConfig();
  if (!cfg.client_id) return;
  const storedClient = d.authClientId || decodeIdTokenAud(d.tokens.id_token);
  if (storedClient && storedClient !== cfg.client_id) {
    console.log('OAuth client changed — clearing stale tokens.');
    delete d.tokens;
    delete d.user;
    delete d.authClientId;
    saveGcalData(d);
  }
}

// Decode JWT "aud" claim (no signature verification — we're just reading it).
function decodeIdTokenAud(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    return JSON.parse(payload).aud || null;
  } catch { return null; }
}
function getSelectedCalendar() { return loadGcalData().calendarId || 'primary'; }
function saveSelectedCalendar(id) { const d = loadGcalData(); d.calendarId = id; saveGcalData(d); }
function getStoredUser()    { return loadGcalData().user || null; }
function saveUser(u)        { const d = loadGcalData(); d.user = u; saveGcalData(d); }

function loadConfig() {
  // Built-in bundled credentials (primary)
  try {
    const bundled = require('./config.json');
    if (bundled && bundled.client_id && bundled.client_secret) return bundled;
  } catch {}
  // Fallback: credentials saved in gcal-data.json (legacy)
  const stored = loadGcalData().oauthConfig;
  if (stored && stored.client_id && stored.client_secret) return stored;
  return { client_id: '', client_secret: '' };
}

function saveOAuthConfig(clientId, clientSecret) {
  const d = loadGcalData();
  d.oauthConfig = { client_id: clientId, client_secret: clientSecret };
  saveGcalData(d);
}

function getOAuthConfig() {
  // Always use bundled config
  try {
    const cfg = require('./config.json');
    if (cfg && cfg.client_id) return { client_id: cfg.client_id, hasSecret: !!(cfg.client_secret) };
  } catch {}
  return { client_id: '', hasSecret: false };
}

// ── Low-level HTTPS helpers ───────────────────────────────────────────────
function httpsGet(reqUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(reqUrl, { headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    }).on('error', reject);
  });
}

function httpsPost(reqUrl, body, headers = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const isJson = typeof body !== 'string';
  const parsed = new URL(reqUrl);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpsPut(reqUrl, body, headers = {}) {
  const bodyStr = JSON.stringify(body);
  const parsed = new URL(reqUrl);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpsDelete(reqUrl, headers = {}) {
  const parsed = new URL(reqUrl);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'DELETE',
      headers,
    }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Token management ─────────────────────────────────────────────────────
async function refreshAccessToken(tokens, config) {
  const params = new URLSearchParams({
    client_id:     config.client_id,
    client_secret: config.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type:    'refresh_token',
  });

  const res = await httpsPost(TOKEN_URL, params.toString());
  if (res.status !== 200) throw new Error(`Token refresh failed: ${JSON.stringify(res.data)}`);

  const updated = { ...tokens, ...res.data, obtained_at: Date.now() };
  saveTokens(updated);
  return updated;
}

async function getValidTokens() {
  invalidateStaleTokens();
  const config = loadConfig();
  let tokens = getStoredTokens();
  if (!tokens) throw new Error('인증되지 않았습니다');

  // Refresh if expired (expires_in is in seconds, give 60s buffer)
  const obtainedAt = tokens.obtained_at || 0;
  const expiresIn  = tokens.expires_in  || 3600;
  if (Date.now() > obtainedAt + (expiresIn - 60) * 1000) {
    tokens = await refreshAccessToken(tokens, config);
  }
  return tokens;
}

function authHeader(tokens) {
  return { Authorization: `Bearer ${tokens.access_token}` };
}

// ── OAuth2 authorize ──────────────────────────────────────────────────────
async function authorizeGoogle() {
  const config = loadConfig();
  if (!config.client_id || !config.client_secret) {
    throw new Error('src/config.json에 client_id와 client_secret을 입력해주세요');
  }

  const params = new URLSearchParams({
    client_id:     config.client_id,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
  });

  await shell.openExternal(`${AUTH_URL}?${params}`);

  return new Promise((resolve, reject) => {
    let server;
    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth timeout (5분 초과)'));
    }, 5 * 60 * 1000);

    server = http.createServer(async (req, res) => {
      const qs = new URLSearchParams(new URL(req.url, 'http://localhost').search);

      if (qs.get('error')) {
        res.end(`<html><body><h2>인증 실패: ${qs.get('error')}</h2><p>이 창을 닫으세요.</p></body></html>`);
        clearTimeout(timeout); server.close();
        return reject(new Error(qs.get('error')));
      }

      const code = qs.get('code');
      if (!code) return res.end('<html><body><p>대기 중...</p></body></html>');

      try {
        // Exchange code for tokens
        const tokenParams = new URLSearchParams({
          code, client_id: config.client_id, client_secret: config.client_secret,
          redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
        });
        const tokenRes = await httpsPost(TOKEN_URL, tokenParams.toString());
        if (tokenRes.status !== 200) throw new Error(`Token exchange failed: ${JSON.stringify(tokenRes.data)}`);

        const tokens = { ...tokenRes.data, obtained_at: Date.now() };
        saveTokens(tokens);

        // Get user info
        try {
          const uRes = await httpsGet(USERINFO_URL, authHeader(tokens));
          if (uRes.status === 200) saveUser({ email: uRes.data.email, name: uRes.data.name, picture: uRes.data.picture });
        } catch (e) { console.error('userinfo error:', e.message); }

        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ TimePing 연결 완료!</h2><p>Google 계정이 연결되었습니다. 이 창을 닫으세요.</p></body></html>');
        clearTimeout(timeout); server.close();
        resolve(tokens);
      } catch (e) {
        res.end(`<html><body><h2>오류: ${e.message}</h2></body></html>`);
        clearTimeout(timeout); server.close();
        reject(e);
      }
    });

    server.listen(3000, 'localhost');
    server.on('error', e => { clearTimeout(timeout); reject(e); });
  });
}

// ── Calendar API ──────────────────────────────────────────────────────────
async function getCalendarList() {
  const tokens = await getValidTokens();
  const res = await httpsGet(`${CALENDAR_API}/users/me/calendarList`, authHeader(tokens));
  if (res.status !== 200) throw new Error(`캘린더 목록 조회 실패: ${res.status}`);
  return (res.data.items || []).map(c => ({ id: c.id, summary: c.summary, primary: c.primary }));
}

function buildEventBody(task) {
  const now = new Date();
  const [hour, minute] = (task.alertTime || '09:00').split(':').map(Number);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let startDate;
  if (task.repeat === 'ONCE' && task.targetDate) {
    startDate = new Date(task.targetDate);
  } else if (task.repeat === 'WEEKLY' && task.repeatDay != null) {
    startDate = new Date(now);
    startDate.setDate(now.getDate() + (task.repeatDay - now.getDay() + 7) % 7);
  } else if (task.repeat === 'MONTHLY' && task.repeatDay != null) {
    startDate = new Date(now.getFullYear(), now.getMonth(), task.repeatDay);
    if (startDate < now) startDate.setMonth(startDate.getMonth() + 1);
  } else {
    startDate = new Date(now);
  }

  startDate.setHours(hour, minute, 0, 0);
  const endDate = new Date(startDate.getTime() + 3600000);

  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

  const body = {
    summary: task.title,
    description: `우선순위: ${task.priority || ''}${task.memo ? '\n' + task.memo : ''}`,
    start: { dateTime: fmt(startDate), timeZone: tz },
    end:   { dateTime: fmt(endDate),   timeZone: tz },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
  };

  const days = ['SU','MO','TU','WE','TH','FR','SA'];
  if      (task.repeat === 'DAILY')   body.recurrence = ['RRULE:FREQ=DAILY'];
  else if (task.repeat === 'WEEKLY')  body.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${days[task.repeatDay]}`];
  else if (task.repeat === 'MONTHLY') body.recurrence = [`RRULE:FREQ=MONTHLY;BYMONTHDAY=${task.repeatDay}`];

  return body;
}

function gcalError(action, status, body) {
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
  const msg    = body?.error?.message || JSON.stringify(body) || '';
  if (status === 401) return new Error(`${action}: 401 — 인증이 만료되었습니다. 다시 로그인해주세요 (${msg})`);
  if (status === 404) return new Error(`${action}: 404 — 이벤트 또는 캘린더를 찾을 수 없습니다`);
  if (status === 403) {
    if (reason === 'insufficientPermissions' || msg.includes('insufficient'))
      return new Error(`${action}: 403 insufficientPermissions — 토큰에 Calendar 권한이 없습니다. 연결 해제 후 재로그인 필요`);
    if (reason === 'accessNotConfigured' || msg.includes('accessNotConfigured'))
      return new Error(`${action}: 403 accessNotConfigured — Calendar API 미활성화. Cloud Console에서 활성화 필요`);
    return new Error(`${action}: 403 [${reason}] ${msg}`);
  }
  return new Error(`${action}: ${status} ${msg}`);
}

async function listEvents(calendarId, options = {}) {
  const tokens = await getValidTokens();
  const calId = calendarId || 'primary';
  const now = new Date();
  const past   = new Date(now.getTime() - (options.daysPast  || 0)  * 24 * 60 * 60 * 1000);
  const future = new Date(now.getTime() + (options.daysAhead || 60) * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    timeMin: past.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(options.maxResults || 250),
  });

  const res = await httpsGet(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events?${params}`,
    authHeader(tokens)
  );
  if (res.status !== 200) throw gcalError('이벤트 목록 가져오기 실패', res.status, res.data);
  return res.data.items || [];
}

async function createEvent(task, calendarId) {
  const tokens = await getValidTokens();
  const calId = calendarId || 'primary';
  const res = await httpsPost(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events`,
    buildEventBody(task),
    authHeader(tokens)
  );
  if (res.status < 200 || res.status >= 300) throw gcalError('이벤트 생성 실패', res.status, res.data);
  return res.data.id;
}

async function updateEvent(task, calendarId) {
  if (!task.gcalEventId) return;
  const tokens = await getValidTokens();
  const calId = calendarId || 'primary';
  const res = await httpsPut(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(task.gcalEventId)}`,
    buildEventBody(task),
    authHeader(tokens)
  );
  if (res.status < 200 || res.status >= 300) throw gcalError('이벤트 수정 실패', res.status, res.data);
}

async function deleteEvent(eventId, calendarId) {
  if (!eventId) return;
  const tokens = await getValidTokens();
  const calId = calendarId || 'primary';
  await httpsDelete(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
    authHeader(tokens)
  );
}

// ── Pending sync queue ────────────────────────────────────────────────────
function addToPendingSync(op) {
  const d = loadGcalData();
  d.pendingSync = d.pendingSync || [];
  d.pendingSync.push({ ...op, queuedAt: new Date().toISOString() });
  saveGcalData(d);
}

async function processPendingSync() {
  if (!isAuthenticated()) return;
  const d = loadGcalData();
  const queue = d.pendingSync || [];
  if (!queue.length) return;

  const calId = getSelectedCalendar();
  const remaining = [];
  for (const op of queue) {
    try {
      if      (op.type === 'create') await createEvent(op.task, calId);
      else if (op.type === 'update') await updateEvent(op.task, calId);
      else if (op.type === 'delete') await deleteEvent(op.eventId, calId);
    } catch (e) {
      console.error('Pending sync failed:', e.message);
      remaining.push(op);
    }
  }
  d.pendingSync = remaining;
  saveGcalData(d);
}

function revokeAuth() {
  const d = loadGcalData();
  delete d.tokens;
  delete d.user;
  saveGcalData(d);
}

function isAuthenticated() {
  invalidateStaleTokens();
  return !!getStoredTokens();
}

// Return a valid id_token (refreshing access_token/id_token if needed).
// Used by Firebase auth to federate with Google sign-in.
async function getValidIdToken() {
  const t = await getValidTokens();
  return t.id_token || null;
}

module.exports = {
  authorizeGoogle, getCalendarList, listEvents,
  createEvent, updateEvent, deleteEvent,
  processPendingSync, addToPendingSync,
  revokeAuth, isAuthenticated,
  getStoredUser, getSelectedCalendar, saveSelectedCalendar,
  saveOAuthConfig, getOAuthConfig,
  getValidIdToken,
};
