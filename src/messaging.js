/**
 * messaging.js — Firebase client for "까먹지 말자" v2.0
 *
 * Uses Firebase REST APIs (Identity Toolkit + Firestore) from the Electron
 * main process. Reuses the Google OAuth id_token already obtained by gcal.js
 * to federate-sign-in to Firebase (no second login).
 *
 * Features supported:
 *  - 쪽지 (memo):  text message sent to another user (identified by email)
 *  - 찌르기 (poke): a proposed task sent to another user, with accept/decline
 *
 * Real-time delivery is implemented via Firestore REST polling (5s interval).
 * This is simpler than WebChannel and adequate for a desktop app.
 */

const https = require('https');
const path  = require('path');
const fs    = require('fs');
const { app } = require('electron');
const gcal  = require('./gcal');
const firebaseConfig = require('./firebase-config');

const IDP_URL   = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${firebaseConfig.apiKey}`;
const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`;
const FS_BASE  = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;

// Poll interval. Was 5s on initial release but that exhausts the Firestore
// free-tier quota (50K reads/day) within ~3 hours of being open. 60s is plenty
// for a chat-style notification UX and stays comfortably within free quota.
const POLL_INTERVAL_MS = 60 * 1000;
// On quota errors, back off for 30 min before resuming polls.
const QUOTA_BACKOFF_MS = 30 * 60 * 1000;
let backoffUntil = 0;

let pollTimer = null;
let inboxCache = [];            // latest fetched inbox
let listeners = [];             // callbacks for inbox updates
let initialized = false;

// ── Persistence ───────────────────────────────────────────────────────────
function storagePath() {
  return path.join(app.getPath('userData'), 'firebase-data.json');
}
function loadFbData() {
  try {
    if (fs.existsSync(storagePath())) return JSON.parse(fs.readFileSync(storagePath(), 'utf-8'));
  } catch {}
  return {};
}
function saveFbData(data) {
  try { fs.writeFileSync(storagePath(), JSON.stringify(data, null, 2)); }
  catch (e) { console.error('firebase-data save error:', e.message); }
}

// ── Low-level HTTPS helpers (JSON-in/JSON-out) ────────────────────────────
function request(method, url, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let data;
        try { data = buf ? JSON.parse(buf) : null; } catch { data = buf; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Auth: federate Google id_token → Firebase tokens ──────────────────────
async function signInWithGoogle() {
  const idToken = await gcal.getValidIdToken();
  if (!idToken) throw new Error('Google 로그인이 필요합니다 (Gcal 연결 먼저 설정)');

  const res = await request('POST', IDP_URL, {
    body: {
      postBody: `id_token=${idToken}&providerId=google.com`,
      requestUri: 'http://localhost',
      returnSecureToken: true,
      returnIdpCredential: true,
    },
  });
  if (res.status !== 200) {
    throw new Error(`Firebase sign-in failed: ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
  }

  const d = res.data;
  const fb = {
    idToken:       d.idToken,
    refreshToken:  d.refreshToken,
    expiresAt:     Date.now() + Number(d.expiresIn || 3600) * 1000,
    localId:       d.localId,
    email:         d.email,
    displayName:   d.displayName || d.fullName || '',
  };
  const all = loadFbData();
  all.auth = fb;
  saveFbData(all);
  return fb;
}

async function refreshFirebaseToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await request('POST', REFRESH_URL, {
    body: { grant_type: 'refresh_token', refresh_token: refreshToken },
  });
  // securetoken endpoint returns snake_case tokens
  if (res.status !== 200) throw new Error(`Refresh failed: ${res.status} ${JSON.stringify(res.data)}`);
  const d = res.data;
  const auth = {
    idToken:      d.id_token,
    refreshToken: d.refresh_token,
    expiresAt:    Date.now() + Number(d.expires_in || 3600) * 1000,
    localId:      d.user_id,
    email:        loadFbData().auth?.email,
    displayName:  loadFbData().auth?.displayName || '',
  };
  const all = loadFbData();
  all.auth = auth;
  saveFbData(all);
  return auth;
}

async function getValidAuth() {
  const all = loadFbData();
  let auth = all.auth;
  if (!auth) return await signInWithGoogle();
  if (Date.now() > auth.expiresAt - 60000) {
    try { auth = await refreshFirebaseToken(auth.refreshToken); }
    catch (e) {
      // Refresh failed — try a fresh sign-in with the Google id_token
      console.warn('Firebase refresh failed, re-signing in:', e.message);
      auth = await signInWithGoogle();
    }
  }
  return auth;
}

function currentUser() {
  return loadFbData().auth || null;
}
function isSignedIn() { return !!loadFbData().auth; }

function signOut() {
  const d = loadFbData();
  delete d.auth;
  saveFbData(d);
}

// ── Firestore helpers (REST with value encoding) ──────────────────────────
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string')   return { stringValue: v };
  if (typeof v === 'boolean')  return { booleanValue: v };
  if (typeof v === 'number')   return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date)       return { timestampValue: v.toISOString() };
  if (Array.isArray(v))        return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = encodeValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeValue(v);
  return fields;
}
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue'    in v) return v.stringValue;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue'      in v) return null;
  if ('mapValue'       in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = decodeValue(val);
    return out;
  }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}
function decodeDocument(doc) {
  if (!doc) return null;
  const id = (doc.name || '').split('/').pop();
  const data = {};
  for (const [k, v] of Object.entries(doc.fields || {})) data[k] = decodeValue(v);
  return { id, ...data };
}

async function fsRequest(method, pathSuffix, body = null) {
  const auth = await getValidAuth();
  const url = `${FS_BASE}/${pathSuffix}`;
  const headers = { Authorization: `Bearer ${auth.idToken}` };
  const res = await request(method, url, { body, headers });
  if (res.status < 200 || res.status >= 300) {
    const msg = res.data?.error?.message || JSON.stringify(res.data).slice(0, 300);
    throw new Error(`Firestore ${method} ${pathSuffix} → ${res.status}: ${msg}`);
  }
  return res.data;
}

// ── User profile registration ─────────────────────────────────────────────
async function ensureUserProfile() {
  const auth = await getValidAuth();
  const email = auth.email;
  if (!email) throw new Error('이메일 정보 없음');
  const domain = email.split('@')[1] || '';
  const fields = encodeFields({
    email,
    domain,
    displayName: auth.displayName || '',
    updatedAt: new Date(),
  });
  // PATCH creates if absent, updates if present (document ID = email)
  // Use updateMask to avoid clobbering other fields (none for now, but future-proof)
  await fsRequest(
    'PATCH',
    `users/${encodeURIComponent(email)}?updateMask.fieldPaths=email&updateMask.fieldPaths=domain&updateMask.fieldPaths=displayName&updateMask.fieldPaths=updatedAt`,
    { fields }
  );
  return { email, domain, displayName: auth.displayName };
}

async function listContactsSameDomain() {
  // Defensive: re-run profile registration in case the initial init() failed
  // (e.g. transient quota error on first launch). Idempotent server-side.
  try { await ensureUserProfile(); } catch (e) {
    console.warn('ensureUserProfile retry on listContacts:', e.message);
  }

  const auth = await getValidAuth();
  const myDomain = (auth.email || '').split('@')[1] || '';
  if (!myDomain) return [];

  // Use a structured query to filter by domain
  const parent = `projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'users' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'domain' },
          op: 'EQUAL',
          value: { stringValue: myDomain },
        },
      },
      limit: 200,
    },
  };
  const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;
  const headers = { Authorization: `Bearer ${auth.idToken}`, 'Content-Type': 'application/json' };
  const res = await request('POST', url, { body, headers });
  if (res.status !== 200) {
    console.error('listContacts runQuery failed:', res.status, res.data);
    return [];
  }
  const rows = (res.data || []).filter(r => r.document).map(r => decodeDocument(r.document));
  return rows.filter(u => u.email && u.email !== auth.email);
}

// ── Send messages ─────────────────────────────────────────────────────────
// type='memo': body.text
// type='poke': body.taskPayload = { title, alertTime, targetDate, repeat, repeatDay, memo, priority }
async function sendMessage(to, type, payload) {
  const auth = await getValidAuth();
  const fields = encodeFields({
    from:         auth.email,
    fromName:     auth.displayName || auth.email,
    to:           String(to).toLowerCase(),
    type:         type,      // 'memo' | 'poke'
    payload:      payload || {},
    status:       'unread',  // 'unread' | 'read' | 'accepted' | 'declined'
    createdAt:    new Date(),
  });
  const res = await fsRequest('POST', 'messages', { fields });
  return decodeDocument(res);
}

async function markRead(messageId) {
  const fields = encodeFields({ status: 'read', readAt: new Date() });
  await fsRequest(
    'PATCH',
    `messages/${encodeURIComponent(messageId)}?updateMask.fieldPaths=status&updateMask.fieldPaths=readAt`,
    { fields }
  );
}

async function respondPoke(messageId, accepted) {
  const fields = encodeFields({
    status:      accepted ? 'accepted' : 'declined',
    respondedAt: new Date(),
  });
  await fsRequest(
    'PATCH',
    `messages/${encodeURIComponent(messageId)}?updateMask.fieldPaths=status&updateMask.fieldPaths=respondedAt`,
    { fields }
  );
}

async function deleteMessage(messageId) {
  try {
    await fsRequest('DELETE', `messages/${encodeURIComponent(messageId)}`);
  } catch (e) { console.error('deleteMessage:', e.message); }
}

// ── Fetch inbox ───────────────────────────────────────────────────────────
async function fetchInbox(limit = 50) {
  // Query WHERE to == me. We deliberately avoid a server-side ORDER BY on
  // a different field so the query doesn't require a composite Firestore
  // index (which would demand a one-time user setup step). Sort client-side.
  const auth = await getValidAuth();
  const parent = `projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'messages' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'to' },
          op: 'EQUAL',
          value: { stringValue: auth.email },
        },
      },
      limit,
    },
  };
  const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;
  const res = await request('POST', url, {
    body,
    headers: { Authorization: `Bearer ${auth.idToken}` },
  });
  if (res.status === 429) {
    backoffUntil = Date.now() + QUOTA_BACKOFF_MS;
    console.warn('Firestore quota exceeded — backing off for 30 min');
    return [];
  }
  if (res.status !== 200) {
    console.error('fetchInbox error:', res.status, res.data);
    return [];
  }
  const docs = (res.data || []).filter(r => r.document).map(r => decodeDocument(r.document));
  // Newest first (client-side)
  docs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return docs;
}

// ── Polling ───────────────────────────────────────────────────────────────
function onInboxUpdate(cb) {
  listeners.push(cb);
  // Immediately emit last known
  if (inboxCache.length) setTimeout(() => cb(inboxCache), 0);
  return () => { listeners = listeners.filter(l => l !== cb); };
}

async function pollOnce() {
  if (Date.now() < backoffUntil) return;   // wait out quota throttle
  try {
    const items = await fetchInbox();
    const prevIds = new Set(inboxCache.map(m => m.id));
    const newArrivals = items.filter(m => !prevIds.has(m.id) && m.status === 'unread');
    inboxCache = items;
    listeners.forEach(cb => { try { cb(items, newArrivals); } catch (e) { console.error('listener err', e); } });
  } catch (e) {
    console.error('pollOnce error:', e.message);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
async function init() {
  if (initialized) return currentUser();
  if (!gcal.isAuthenticated()) return null;
  try {
    await signInWithGoogle();
    await ensureUserProfile();
    startPolling();
    initialized = true;
    return currentUser();
  } catch (e) {
    console.error('messaging.init failed:', e.message);
    return null;
  }
}

// ── Update manifest check (GitHub Releases) ───────────────────────────────
// Fetches the latest release from the GitHub repo and matches the asset
// appropriate to the current OS+arch.
//
//   macOS arm64  → asset name contains "mac-arm64"
//   macOS x64    → asset name contains "mac-x64"
//   Windows      → asset name contains "setup" (NSIS installer preferred)
//                  or falls back to "portable"
//
// Returns: { version, downloadUrl, notes, allAssets } or null on failure.
const GITHUB_REPO = 'deutsche21-design/timeping';

async function fetchLatestVersionInfo() {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const res = await request('GET', url, {
      headers: {
        'User-Agent': 'kkameokji-app',
        'Accept': 'application/vnd.github+json',
      },
    });
    if (res.status === 404) return null;
    if (res.status !== 200) {
      console.error('GitHub releases fetch error:', res.status, res.data);
      return null;
    }
    const release = res.data;
    const tag = String(release.tag_name || '').replace(/^v/, '');

    // Pick asset matching this platform/arch
    const assets = release.assets || [];
    const platform = process.platform;   // 'darwin' | 'win32' | 'linux'
    const arch = process.arch;           // 'arm64' | 'x64' | ...
    let pick = null;

    if (platform === 'darwin') {
      const archTag = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
      pick = assets.find(a => a.name.includes(archTag) && a.name.endsWith('.zip'));
    } else if (platform === 'win32') {
      // Prefer .zip — extracting it via tar.exe + xcopy avoids running an
      // unsigned setup.exe (which Windows Defender / SmartScreen often blocks).
      pick = assets.find(a => a.name.includes('win') && a.name.endsWith('.zip'))
          || assets.find(a => a.name.includes('setup') && a.name.endsWith('.exe'))
          || assets.find(a => a.name.includes('portable') && a.name.endsWith('.exe'));
    }
    // Fallback: html_url so user can pick manually
    const downloadUrl = pick ? pick.browser_download_url : release.html_url;

    return {
      version:     tag,
      downloadUrl,
      notes:       release.body || '',
      assetName:   pick ? pick.name : null,
      releaseUrl:  release.html_url,
    };
  } catch (e) {
    console.error('fetchLatestVersionInfo:', e.message);
    return null;
  }
}

module.exports = {
  init, signInWithGoogle, signOut, currentUser, isSignedIn,
  ensureUserProfile,
  listContactsSameDomain,
  sendMessage, markRead, respondPoke, deleteMessage,
  fetchInbox, onInboxUpdate,
  startPolling, stopPolling,
  fetchLatestVersionInfo,
};
