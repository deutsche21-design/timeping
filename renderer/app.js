// ─── TimePing Renderer — Todo-first App ──────────────────────────────────────

// ─── Constants ────────────────────────────────────────────────────────────────
const REPEAT_LABELS  = { ONCE: '1회', DAILY: '매일', WEEKLY: '매주', MONTHLY: '매월' };
const DAYS           = ['일', '월', '화', '수', '목', '금', '토'];
const CHANNEL_ICONS  = { system: '🔔', popup: '💬', sound: '🔊', email: '📧' };
const CHANNEL_LABELS = { system: '시스템', popup: '팝업', sound: '소리', email: '메일' };
const SMTP_PRESETS   = {
  gmail:   { host: 'smtp.gmail.com',   port: 587 },
  naver:   { host: 'smtp.naver.com',   port: 587 },
  outlook: { host: 'smtp.office365.com', port: 587 },
};

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  appVersion:     '',
  tasks:          [],
  settings:       {},
  tab:            'tasks',       // 'tasks' | 'schedule' | 'history' | 'settings'
  calDate:        null,          // selected date in schedule tab (null = today)
  filter:         'today',       // 'all' | 'today' | 'alert' — Feature 5: default to today-only
  inbox:          [],            // remote messages for this user
  inboxOpen:      false,         // inbox modal open
  composeOpen:    false,         // compose modal open
  composeMode:    'memo',        // 'memo' | 'poke'
  contacts:       [],            // cached contacts (same domain)
  composeTo:      '',
  composeTitle:   '',
  composeText:    '',
  composeAlertTime: '09:00',
  composeDate:    '',
  remoteUser:     null,          // Firebase user info once signed in
  search:         '',
  searchOpen:     false,
  historySearch:  '',
  historyFrom:    null,   // 'YYYY-MM-DD' or null
  historyTo:      null,   // 'YYYY-MM-DD' or null
  settingsTab:    'general',     // 'general' | 'email' | 'gcal'
  gcalStatus:     null,
  gcalCalendars:  [],
  gcalConfig:     null,
  expandedId:     null,          // task id being edited in-place
  expandEdits:    {},            // { [id]: partialTask } — draft edits per task
  quickAdd: {
    text:         '',
    pickerOpen:   false,
    showHint:     false,
    alertTime:    null,          // "HH:MM" or null
    repeat:       'ONCE',
    repeatDay:    null,
    targetDate:   todayStr(),
    channels:     ['system', 'popup', 'sound'],   // Feature 11: sound by default
    pickerHour:   9,
    pickerMin:    0,
  },
  toast:          null,
  confirmDialog:  null,
  selectMode:     false,
  selectedIds:    [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Friendly date label for a task's targetDate
//   today  → "오늘"
//   tmrw   → "내일"
//   future → "M월 D일 (요일)"
//   past   → "지남" (this list shouldn't have these but defensive)
function formatTaskDateLabel(dateStr) {
  if (!dateStr) return '';
  const today = todayStr();
  if (dateStr === today) return '오늘';
  if (dateStr === tomorrowStr()) return '내일';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return '';
  const date = new Date(y, m - 1, d);
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const dow = ['일','월','화','수','목','금','토'][date.getDay()];
  if (date < todayDate) return '지남';
  return `${m}/${d} (${dow})`;
}

// Snooze badge HTML — '' if not snoozed
function formatSnoozeBadge(task) {
  if (!task.snoozeUntil) return '';
  const ms = Number(task.snoozeUntil) - Date.now();
  if (ms <= 0) return '';
  const d = new Date(Number(task.snoozeUntil));
  const h = String(d.getHours()).padStart(2,'0');
  const m = String(d.getMinutes()).padStart(2,'0');
  return `<span class="task-snooze-badge">💤 ${h}:${m} 재알림</span>`;
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDateKo(dateStr) {
  const [y, m, dd] = dateStr.split('-');
  return `${m}월 ${parseInt(dd)}일`;
}

function formatDateLong(dateStr) {
  const [y, m, dd] = dateStr.split('-');
  return `${y}년 ${parseInt(m)}월 ${parseInt(dd)}일`;
}

function formatCompletedAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2,'0');
  const mn = String(d.getMinutes()).padStart(2,'0');
  return `${h}:${mn}`;
}

function isToday(dateStr) {
  return dateStr === todayStr();
}

function isThisWeek(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay());
  startOfWeek.setHours(0,0,0,0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23,59,59,999);
  return d >= startOfWeek && d <= endOfWeek;
}

function taskIsToday(task) {
  const now = new Date();
  const todayDate = now.getDate();
  const todayDay  = now.getDay();
  if (!task.repeat || task.repeat === 'ONCE') {
    return task.targetDate === todayStr();
  }
  if (task.repeat === 'DAILY') return true;
  if (task.repeat === 'WEEKLY') return task.repeatDay === todayDay;
  if (task.repeat === 'MONTHLY') return task.repeatDay === todayDate;
  return false;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Natural Language Parser ──────────────────────────────────────────────────
function parseQuickInput(text) {
  let title = text;
  let alertTime = null;
  let repeat = 'ONCE';
  let repeatDay = null;
  let targetDate = todayStr();

  // Extract @HH:MM
  const timeMatch = title.match(/@(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const h = String(parseInt(timeMatch[1])).padStart(2,'0');
    const m = String(parseInt(timeMatch[2])).padStart(2,'0');
    alertTime = `${h}:${m}`;
    title = title.replace(timeMatch[0], '').trim();
  }

  // Extract repeat
  if (/매일/.test(title)) {
    repeat = 'DAILY';
    title = title.replace(/매일/, '').trim();
  } else if (/매주/.test(title)) {
    repeat = 'WEEKLY';
    const dayMatch = title.match(/매주\s*([월화수목금토일])/);
    if (dayMatch) {
      const idx = ['일','월','화','수','목','금','토'].indexOf(dayMatch[1]);
      repeatDay = idx >= 0 ? idx : new Date().getDay();
      title = title.replace(/매주\s*[월화수목금토일]?/, '').trim();
    } else {
      repeatDay = new Date().getDay();
      title = title.replace(/매주/, '').trim();
    }
  } else if (/매월/.test(title)) {
    repeat = 'MONTHLY';
    const dayMatch = title.match(/매월\s*(\d+)일?/);
    if (dayMatch) {
      repeatDay = parseInt(dayMatch[1]);
      title = title.replace(/매월\s*\d+일?/, '').trim();
    } else {
      repeatDay = new Date().getDate();
      title = title.replace(/매월/, '').trim();
    }
  }

  return { title, alertTime, repeat, repeatDay, targetDate };
}

// ─── Clock ────────────────────────────────────────────────────────────────────
let clockInterval = null;

function startClock() {
  updateClock();
  clockInterval = setInterval(updateClock, 1000);
}

function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  const h = String(now.getHours()).padStart(2,'0');
  const m = String(now.getMinutes()).padStart(2,'0');
  const s = String(now.getSeconds()).padStart(2,'0');
  const dow = ['일','월','화','수','목','금','토'][now.getDay()];
  const dateStr = `${now.getMonth()+1}/${now.getDate()} (${dow})`;
  el.innerHTML = `<span class="clock-time">${h}:${m}:${s}</span><span class="clock-date">${dateStr}</span>`;
}

// Cache app version in state once on startup; renders pick it up via the
// template above. Also update DOM directly if the header is already mounted.
async function loadAppVersion() {
  try {
    state.appVersion = await window.timeping.getAppVersion();
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${state.appVersion}`;
  } catch {}
}

// ─── Sound ────────────────────────────────────────────────────────────────────
function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {}
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, type = 'success') {
  state.toast = { message, type };
  renderToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    renderToast();
  }, 2600);
}

function renderToast() {
  let el = document.getElementById('toast-container');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-container';
    el.className = 'toast-container';
    document.body.appendChild(el);
  }
  if (!state.toast) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="toast ${state.toast.type}">${esc(state.toast.message)}</div>`;
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────
function showConfirm(title, message, onConfirm) {
  state.confirmDialog = { title, message, onConfirm };
  renderConfirm();
}

function renderConfirm() {
  let el = document.getElementById('confirm-overlay');
  if (!state.confirmDialog) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'confirm-overlay';
    document.body.appendChild(el);
  }
  const { title, message } = state.confirmDialog;
  el.className = 'dialog-overlay';
  el.innerHTML = `
    <div class="dialog-box">
      <div class="dialog-title">${esc(title)}</div>
      <div class="dialog-message">${esc(message)}</div>
      <div class="dialog-actions">
        <button class="btn btn-ghost" id="confirm-cancel" style="flex:1">취소</button>
        <button class="btn btn-danger" id="confirm-ok" style="flex:1">삭제</button>
      </div>
    </div>`;
  document.getElementById('confirm-cancel').onclick = () => {
    state.confirmDialog = null;
    renderConfirm();
  };
  document.getElementById('confirm-ok').onclick = () => {
    const cb = state.confirmDialog.onConfirm;
    state.confirmDialog = null;
    renderConfirm();
    if (cb) cb();
  };
}

// ─── HTML escape ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ─── Filter tasks ─────────────────────────────────────────────────────────────
function getFilteredTasks() {
  let tasks = state.tasks.filter(t => !t.isCompleted);

  if (state.filter === 'today') {
    tasks = tasks.filter(taskIsToday);
  } else if (state.filter === 'alert') {
    tasks = tasks.filter(t => !!t.alertTime);
  } else if (state.filter === 'todo') {
    tasks = tasks.filter(t => !t.alertTime);
  }

  if (state.search) {
    const q = state.search.toLowerCase();
    tasks = tasks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.memo && t.memo.toLowerCase().includes(q))
    );
  }

  return tasks;
}

// ─── Build task draft (for expand editing) ───────────────────────────────────
function getDraft(task) {
  return Object.assign({}, task, state.expandEdits[task.id] || {});
}

function setDraft(id, partial) {
  state.expandEdits[id] = Object.assign({}, state.expandEdits[id] || {}, partial);
}

// ─── Layout height adjuster (JS-based — CSS flexbox unreliable with dynamic sections) ──
function adjustLayout() {
  const mc = document.getElementById('main-content');
  if (!mc) return;
  const header = document.querySelector('.app-header');
  const qa     = document.querySelector('.quick-add-section');
  const filter = document.getElementById('filter-section');
  const usedH  = (header ? header.offsetHeight : 0)
               + (qa     ? qa.offsetHeight     : 0)
               + (filter ? filter.offsetHeight  : 0);
  const navH   = 52; // bottom-nav is position:fixed, add padding
  mc.style.height    = (window.innerHeight - usedH) + 'px';
  mc.style.overflowY = 'auto';
  mc.style.overflowX = 'hidden';
}

// ─── Main Render ──────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  if (!app) return;

  // Build the app shell only once, then update inner regions
  const needsShell = !app.querySelector('.app-header');

  if (needsShell) {
    app.innerHTML = `
      <div class="app-header">
        <div class="app-title-wrap">
          <span class="app-title">까먹지 말자</span>
          <span class="app-for" id="app-version">${state.appVersion ? 'v' + state.appVersion : ''}</span>
        </div>
        <span class="clock" id="clock"></span>
      </div>
      ${renderQuickAddSection()}
      <div class="filter-section" id="filter-section"></div>
      <div class="main-content" id="main-content"></div>
      <div class="bottom-nav" id="bottom-nav"></div>
    `;
    bindQuickAddEvents();
  } else {
    // Update quick-add area only when picker state changes
    const qas = app.querySelector('.quick-add-section');
    if (qas) {
      qas.outerHTML; // no-op read (we'll just rerender section)
    }
  }

  // Always update these regions
  updateFilterSection();
  updateMainContent();
  updateBottomNav();
  updateClock();
}

// ─── Full rebuild (for tab change, etc.) ─────────────────────────────────────
function fullRender() {
  const app = document.getElementById('app');
  if (!app) return;
  // Remove bulk bar before full rebuild
  const oldBar = document.getElementById('bulk-action-bar');
  if (oldBar) oldBar.remove();
  app.innerHTML = `
    <div class="app-header">
      <div class="app-title-wrap">
        <span class="app-title">까먹지 말자</span>
        <span class="app-for">for e.j</span>
      </div>
      <span class="clock" id="clock"></span>
    </div>
    ${renderQuickAddSection()}
    <div class="filter-section" id="filter-section"></div>
    <div class="main-content" id="main-content"></div>
    <div class="bottom-nav" id="bottom-nav"></div>
  `;
  bindQuickAddEvents();
  updateFilterSection();
  updateMainContent();
  updateBottomNav();
  updateClock();
  // DOM이 완전히 그려진 뒤 높이 계산
  requestAnimationFrame(adjustLayout);
}

// ─── Quick-Add Section ────────────────────────────────────────────────────────
function renderQuickAddSection() {
  const qa = state.quickAdd;
  const hasAlert = !!qa.alertTime;
  const alarmLabel = hasAlert
    ? `⏰ ${qa.alertTime}${qa.repeat !== 'ONCE' ? ' ' + REPEAT_LABELS[qa.repeat] : ''}`
    : '⏰';

  // Always render hint panel — toggle visibility via JS to avoid destroying the input
  const hintHtml = `
    <div class="quick-hint" id="quick-hint-panel" style="display:${qa.showHint ? '' : 'none'}">
      <div class="quick-hint-title">⌨️ 반복 설정 방법</div>
      <div class="quick-hint-row"><span class="hint-ex">@14:30</span><span class="hint-desc">→ 오늘 한 번</span></div>
      <div class="quick-hint-row"><span class="hint-ex">@14:30 매일</span><span class="hint-desc">→ 매일 반복</span></div>
      <div class="quick-hint-row"><span class="hint-ex">@14:30 매주 월</span><span class="hint-desc">→ 매주 월요일</span></div>
      <div class="quick-hint-row"><span class="hint-ex">@14:30 매월 25</span><span class="hint-desc">→ 매월 25일</span></div>
      <div class="quick-hint-note">또는 ⏰ 버튼으로 선택</div>
    </div>`;

  return `
    <div class="quick-add-section">
      <div class="quick-add-bar">
        <input
          class="quick-add-input"
          id="quick-add-input"
          type="text"
          placeholder="할일을 입력하세요..."
          value="${esc(qa.text)}"
          autocomplete="off"
        >
        <button class="quick-add-alarm-btn${hasAlert ? ' active' : ''}" id="quick-alarm-btn" title="알림 설정">
          <span class="alarm-badge">${esc(alarmLabel)}</span>
        </button>
      </div>
      <div class="quick-add-hint-row">
        <span class="quick-add-hint-enter">↵ Enter로 추가</span>
        <span class="quick-add-hint-at">@14:30으로 알림 · @14:30 매일 반복</span>
      </div>
      ${hintHtml}
      <div class="time-picker-panel${qa.pickerOpen ? ' open' : ''}" id="quick-picker">
        ${renderTimePicker()}
      </div>
    </div>`;
}

function renderTimePicker() {
  const qa = state.quickAdd;
  const h  = String(qa.pickerHour).padStart(2,'0');
  const m  = String(qa.pickerMin).padStart(2,'0');

  let extraRow = '';
  if (qa.repeat === 'ONCE') {
    extraRow = `
      <div class="time-picker-row">
        <span class="time-picker-label">날짜</span>
        <input type="date" class="date-input-sm" id="qp-date" value="${esc(qa.targetDate)}">
      </div>`;
  } else if (qa.repeat === 'WEEKLY') {
    const chips = DAYS.map((d, i) =>
      `<span class="day-chip${qa.repeatDay === i ? ' active' : ''}" data-day="${i}">${d}</span>`
    ).join('');
    extraRow = `
      <div class="time-picker-row">
        <span class="time-picker-label">요일</span>
        <div class="day-chips" id="qp-daychips">${chips}</div>
      </div>`;
  } else if (qa.repeat === 'MONTHLY') {
    extraRow = `
      <div class="time-picker-row">
        <span class="time-picker-label">일</span>
        <input type="number" class="time-spinner-val" id="qp-mday" min="1" max="31"
          value="${qa.repeatDay || new Date().getDate()}" style="width:44px">
      </div>`;
  }

  const channelChips = Object.keys(CHANNEL_ICONS).map(ch => {
    const active = qa.channels.includes(ch);
    return `<span class="channel-chip${active ? ' active' : ''}" data-qp-ch="${ch}">
      ${CHANNEL_ICONS[ch]} ${CHANNEL_LABELS[ch]}</span>`;
  }).join('');

  return `
    <div class="time-picker-inner">
      <div class="time-picker-row">
        <span class="time-picker-label">시간</span>
        <div class="time-spinner">
          <button class="time-spinner-btn" id="qp-h-dn">−</button>
          <input class="time-spinner-val" id="qp-hour" type="number" min="0" max="23" value="${h}">
          <button class="time-spinner-btn" id="qp-h-up">+</button>
        </div>
        <span class="time-colon">:</span>
        <div class="time-spinner">
          <button class="time-spinner-btn" id="qp-m-dn">−</button>
          <input class="time-spinner-val" id="qp-min" type="number" min="0" max="59" value="${m}">
          <button class="time-spinner-btn" id="qp-m-up">+</button>
        </div>
      </div>
      <div class="time-picker-row">
        <span class="time-picker-label">반복</span>
        <select class="repeat-select" id="qp-repeat">
          <option value="ONCE"${qa.repeat==='ONCE'?' selected':''}>1회</option>
          <option value="DAILY"${qa.repeat==='DAILY'?' selected':''}>매일</option>
          <option value="WEEKLY"${qa.repeat==='WEEKLY'?' selected':''}>매주</option>
          <option value="MONTHLY"${qa.repeat==='MONTHLY'?' selected':''}>매월</option>
        </select>
      </div>
      ${extraRow}
      <div class="time-picker-row">
        <span class="time-picker-label">방법</span>
        <div class="channel-chips" id="qp-channels">${channelChips}</div>
      </div>
    </div>`;
}

function bindQuickAddEvents() {
  const inp  = document.getElementById('quick-add-input');
  const btn  = document.getElementById('quick-alarm-btn');

  if (!inp || !btn) return;

  inp.addEventListener('input', e => {
    state.quickAdd.text = e.target.value;
    const hasAt = e.target.value.includes('@');
    // Toggle hint visibility WITHOUT re-rendering (avoids destroying the input/cursor)
    if (state.quickAdd.showHint !== hasAt) {
      state.quickAdd.showHint = hasAt;
      const hintPanel = document.getElementById('quick-hint-panel');
      if (hintPanel) hintPanel.style.display = hasAt ? '' : 'none';
    }
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitQuickAdd();
  });

  btn.addEventListener('click', () => {
    state.quickAdd.pickerOpen = !state.quickAdd.pickerOpen;
    if (state.quickAdd.pickerOpen) {
      if (state.quickAdd.alertTime) {
        // Sync from existing alert time
        const [ph, pm] = state.quickAdd.alertTime.split(':').map(Number);
        state.quickAdd.pickerHour = ph;
        state.quickAdd.pickerMin  = pm;
      } else {
        // Default to current time, rounded up to next 5 min
        const now = new Date();
        const rawMin = now.getMinutes();
        const rounded = Math.ceil(rawMin / 5) * 5;
        state.quickAdd.pickerHour = rounded >= 60 ? (now.getHours() + 1) % 24 : now.getHours();
        state.quickAdd.pickerMin  = rounded % 60;
      }
    }
    refreshQuickAddSection();
  });

  bindTimePickerEvents();
}

function bindTimePickerEvents() {
  const safe = (id, fn) => {
    const el = document.getElementById(id);
    if (el) fn(el);
  };

  safe('qp-h-up',  el => el.addEventListener('click', () => changeQPHour(1)));
  safe('qp-h-dn',  el => el.addEventListener('click', () => changeQPHour(-1)));
  safe('qp-m-up',  el => el.addEventListener('click', () => changeQPMin(5)));
  safe('qp-m-dn',  el => el.addEventListener('click', () => changeQPMin(-5)));

  safe('qp-hour', el => el.addEventListener('change', e => {
    state.quickAdd.pickerHour = Math.max(0, Math.min(23, parseInt(e.target.value)||0));
    syncQPAlertTime();
  }));
  safe('qp-min', el => el.addEventListener('change', e => {
    state.quickAdd.pickerMin = Math.max(0, Math.min(59, parseInt(e.target.value)||0));
    syncQPAlertTime();
  }));
  safe('qp-repeat', el => el.addEventListener('change', e => {
    state.quickAdd.repeat = e.target.value;
    if (e.target.value === 'WEEKLY') state.quickAdd.repeatDay = new Date().getDay();
    if (e.target.value === 'MONTHLY') state.quickAdd.repeatDay = new Date().getDate();
    refreshTimePicker();
  }));
  safe('qp-date', el => el.addEventListener('change', e => {
    state.quickAdd.targetDate = e.target.value;
  }));
  safe('qp-mday', el => el.addEventListener('change', e => {
    state.quickAdd.repeatDay = Math.max(1, Math.min(31, parseInt(e.target.value)||1));
  }));

  // Day chips
  const dc = document.getElementById('qp-daychips');
  if (dc) {
    dc.addEventListener('click', e => {
      const chip = e.target.closest('[data-day]');
      if (!chip) return;
      state.quickAdd.repeatDay = parseInt(chip.dataset.day);
      dc.querySelectorAll('.day-chip').forEach(c =>
        c.classList.toggle('active', parseInt(c.dataset.day) === state.quickAdd.repeatDay)
      );
    });
  }

  // Channel chips
  const qpch = document.getElementById('qp-channels');
  if (qpch) {
    qpch.addEventListener('click', e => {
      const chip = e.target.closest('[data-qp-ch]');
      if (!chip) return;
      const ch = chip.dataset.qpCh;
      const channels = state.quickAdd.channels;
      const idx = channels.indexOf(ch);
      if (idx > -1) channels.splice(idx, 1);
      else channels.push(ch);
      chip.classList.toggle('active', channels.includes(ch));
    });
  }

  // Auto-set alertTime when picker is open and hour/min updated
  syncQPAlertTime();
}

function changeQPHour(delta) {
  state.quickAdd.pickerHour = (state.quickAdd.pickerHour + delta + 24) % 24;
  syncQPAlertTime();
  const el = document.getElementById('qp-hour');
  if (el) el.value = String(state.quickAdd.pickerHour).padStart(2,'0');
}

function changeQPMin(delta) {
  state.quickAdd.pickerMin = (state.quickAdd.pickerMin + delta + 60) % 60;
  syncQPAlertTime();
  const el = document.getElementById('qp-min');
  if (el) el.value = String(state.quickAdd.pickerMin).padStart(2,'0');
}

function syncQPAlertTime() {
  // When picker is open, always apply alert time
  if (state.quickAdd.pickerOpen) {
    const h = String(state.quickAdd.pickerHour).padStart(2,'0');
    const m = String(state.quickAdd.pickerMin).padStart(2,'0');
    state.quickAdd.alertTime = `${h}:${m}`;
    // Update alarm button badge without full rerender
    const badge = document.querySelector('#quick-alarm-btn .alarm-badge');
    if (badge) {
      const label = `⏰ ${state.quickAdd.alertTime}${state.quickAdd.repeat !== 'ONCE' ? ' '+REPEAT_LABELS[state.quickAdd.repeat] : ''}`;
      badge.textContent = label;
    }
  }
}

function refreshTimePicker() {
  const panel = document.getElementById('quick-picker');
  if (!panel) return;
  panel.innerHTML = renderTimePicker();
  bindTimePickerEvents();
}

function refreshQuickAddSection() {
  const section = document.querySelector('.quick-add-section');
  if (!section) return;
  const newHtml = renderQuickAddSection();
  const tmp = document.createElement('div');
  tmp.innerHTML = newHtml;
  const newSection = tmp.firstElementChild;
  section.replaceWith(newSection);
  bindQuickAddEvents();
}

let _submitting = false;
async function submitQuickAdd() {
  if (_submitting) return;
  const rawText = state.quickAdd.text.trim();
  if (!rawText) return;
  _submitting = true;

  // Parse natural language
  const parsed = parseQuickInput(rawText);

  // Override with picker values if picker is open
  let alertTime = parsed.alertTime;
  let repeat    = parsed.repeat;
  let repeatDay = parsed.repeatDay;
  let targetDate = parsed.targetDate;

  if (state.quickAdd.pickerOpen || state.quickAdd.alertTime) {
    alertTime  = state.quickAdd.alertTime;
    repeat     = state.quickAdd.repeat;
    repeatDay  = state.quickAdd.repeatDay;
    targetDate = state.quickAdd.targetDate;
  }

  const now = new Date().toISOString();
  const task = {
    // id는 main.js(uuid)가 부여 — 렌더러에서 미리 만들면 GCal 동기화 경로가 꼬임
    title:          parsed.title || rawText,
    alertTime:      alertTime || null,
    repeat:         repeat || 'ONCE',
    repeatDay:      repeatDay || null,
    targetDate:     targetDate,
    alertChannels:  state.quickAdd.channels.slice(),
    memo:           undefined,
    isCompleted:    false,
    completedAt:    undefined,
    createdAt:      now,
    updatedAt:      now,
  };

  try {
    const savedTasks = await window.timeping.saveTask(task);
    // 저장된 task 찾기 (gcalEventId 유무 확인용)
    const savedTask = savedTasks && savedTasks[savedTasks.length - 1];
    const syncedToGcal = savedTask && savedTask.gcalEventId;

    state.tasks = savedTasks;
    // Reset quick add
    state.quickAdd.text       = '';
    state.quickAdd.alertTime  = null;
    state.quickAdd.pickerOpen = false;
    state.quickAdd.showHint   = false;
    state.quickAdd.repeat     = 'ONCE';
    state.quickAdd.repeatDay  = null;
    state.quickAdd.targetDate = todayStr();
    state.quickAdd.pickerHour = 9;
    state.quickAdd.pickerMin  = 0;
    fullRender();
    // 연속 입력을 위해 포커스 복귀
    requestAnimationFrame(() => {
      document.querySelector('.quick-add-input')?.focus();
    });
    showToast('할일이 추가되었습니다');
    if (syncedToGcal) {
      setTimeout(() => showToast('📅 구글 캘린더에 등록됐어요'), 2700);
    }
  } catch (e) {
    showToast('저장 실패: ' + e.message, 'error');
  } finally {
    _submitting = false;
  }
}

// ─── Filter Section ───────────────────────────────────────────────────────────
function updateFilterSection() {
  const sec = document.getElementById('filter-section');
  if (!sec) return;

  // Only shown on tasks tab
  if (state.tab !== 'tasks') {
    sec.innerHTML = '';
    return;
  }

  const FILTERS = [
    { key: 'today', label: '오늘' },
    { key: 'all',   label: '전체' },
    { key: 'alert', label: '🔔 알림있음' },
    { key: 'todo',  label: '📋 알림없음' },
  ];
  const chipsHtml = FILTERS.map(f =>
    `<button class="filter-chip${state.filter===f.key?' active':''}" data-filter="${f.key}">${f.label}</button>`
  ).join('');

  sec.innerHTML = `
    <div class="filter-bar">
      <div class="filter-chips" id="filter-chips">${chipsHtml}</div>
      <button class="search-toggle-btn${state.searchOpen?' active':''}" id="search-toggle"><span class="s-icon">🔍</span></button>
      <button class="select-mode-btn${state.selectMode?' active':''}" id="select-mode-toggle">${state.selectMode ? '취소' : '선택'}</button>
    </div>
    <div class="search-bar${state.searchOpen?' open':''}" id="search-bar">
      <div class="search-bar-inner">
        <input class="search-input" id="search-input" type="text"
          placeholder="할일 검색..." value="${esc(state.search)}" autocomplete="off">
      </div>
    </div>`;

  // Filter chip clicks
  document.getElementById('filter-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    updateFilterSection();
    updateMainContent();
  });

  document.getElementById('search-toggle').addEventListener('click', () => {
    state.searchOpen = !state.searchOpen;
    if (!state.searchOpen) state.search = '';
    updateFilterSection();
    if (state.searchOpen) updateMainContent();
    if (state.searchOpen) {
      const si = document.getElementById('search-input');
      if (si) si.focus();
    }
  });

  document.getElementById('select-mode-toggle').addEventListener('click', () => {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selectedIds = [];
    updateFilterSection();
    updateMainContent();
    updateBulkBar();
  });

  const si = document.getElementById('search-input');
  if (si) {
    si.addEventListener('input', e => {
      state.search = e.target.value;
      updateMainContent();
    });
  }
}

// ─── Main Content ─────────────────────────────────────────────────────────────
function updateMainContent() {
  const old = document.getElementById('main-content');
  if (!old) return;
  const mc = document.createElement('div');
  mc.id = 'main-content';
  mc.className = 'main-content';
  old.replaceWith(mc);

  if (state.tab === 'tasks')         { mc.innerHTML = renderTaskListView(); bindTaskListEvents(mc); }
  else if (state.tab === 'schedule') { mc.innerHTML = renderCalendarView(); bindCalendarEvents(mc); }
  else if (state.tab === 'history')  { mc.innerHTML = renderHistoryView(); bindHistoryEvents(mc); }
  else if (state.tab === 'settings') { mc.innerHTML = renderSettingsView(); bindSettingsEvents(mc); }

  requestAnimationFrame(() => {
    adjustLayout();
    updateBulkBar();
  });
}

// ─── Task List View ───────────────────────────────────────────────────────────
function renderTaskListView() {
  const today = todayStr();
  // Deduplicate by ID (guard against duplicate saves)
  const allTasks = [...new Map(state.tasks.map(t => [t.id, t])).values()];

  // Section 1: Today timeline
  // - Incomplete tasks scheduled for today that have alertTime
  // - Completed tasks completed today (any, even without alertTime)
  const todayIncomplete = allTasks.filter(t =>
    !t.isCompleted && taskIsToday(t) && t.alertTime
  );
  const todayCompleted = allTasks.filter(t =>
    t.isCompleted && (t.completedAt || '').slice(0, 10) === today
  );
  const timelineItems = [...todayIncomplete, ...todayCompleted];
  // Sort by alertTime (nulls go to bottom)
  timelineItems.sort((a, b) => {
    if (!a.alertTime && !b.alertTime) return 0;
    if (!a.alertTime) return 1;
    if (!b.alertTime) return -1;
    return a.alertTime.localeCompare(b.alertTime);
  });

  // Section 2: Todo list - incomplete tasks NOT already in timeline
  // gcalImported tasks only appear in the timeline (today), not in general todo list
  const timelineIds = new Set(todayIncomplete.map(t => t.id));
  let todoTasks = allTasks.filter(t => !t.isCompleted && !timelineIds.has(t.id) && !t.gcalImported);

  // Apply filters and search to todo list
  if (state.filter === 'today') {
    todoTasks = todoTasks.filter(taskIsToday);
  } else if (state.filter === 'alert') {
    todoTasks = todoTasks.filter(t => !!t.alertTime);
  } else if (state.filter === 'todo') {
    todoTasks = todoTasks.filter(t => !t.alertTime);
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    todoTasks = todoTasks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.memo && t.memo.toLowerCase().includes(q))
    );
  }

  // When filter is 'today', also apply to timeline
  let filteredTimeline = timelineItems;
  if (state.filter === 'alert') {
    filteredTimeline = timelineItems.filter(t => !!t.alertTime);
  } else if (state.filter === 'todo') {
    filteredTimeline = timelineItems.filter(t => !t.alertTime);
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    filteredTimeline = filteredTimeline.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.memo && t.memo.toLowerCase().includes(q))
    );
  }

  const hasTimeline = filteredTimeline.length > 0;
  const hasTodo = todoTasks.length > 0;

  if (!hasTimeline && !hasTodo) {
    let msg = '할일이 없습니다';
    if (state.filter === 'today')  msg = '오늘 할일이 없습니다';
    if (state.filter === 'alert')  msg = '알림이 설정된 할일이 없습니다';
    if (state.filter === 'todo')   msg = '알림 없는 할일이 없습니다';
    if (state.search)              msg = '검색 결과가 없습니다';
    return `
      <div class="task-list-view">
        <div class="empty-state" style="height:160px">
          <div class="empty-state-icon">📋</div>
          <div class="empty-state-text">${msg}</div>
        </div>
      </div>`;
  }

  let html = `<div class="task-list-view">`;

  // Section 1: Timeline
  if (hasTimeline) {
    const timelineHtml = filteredTimeline.map(t => {
      const isExp = state.expandedId === t.id;
      const expandHtml = isExp ? renderTaskExpand(getDraft(t)) : '';
      const isSel = state.selectedIds.includes(t.id);
      const selClass = state.selectMode ? ' select-mode' + (isSel ? ' selected' : '') : '';
      return `
        <div class="timeline-item${t.isCompleted ? ' done' : ''}${isExp ? ' expanded' : ''}${selClass}" data-id="${t.id}">
          <div class="timeline-row">
            ${state.selectMode
              ? `<div class="select-circle${isSel?' selected':''}" data-select="${t.id}">${isSel?'✓':''}</div>`
              : `<div class="timeline-check${t.isCompleted ? ' checked' : ''}" data-complete="${t.id}">${t.isCompleted ? '✓' : ''}</div>`
            }
            <div class="timeline-time">${t.alertTime || '–'}</div>
            <div class="timeline-title"${state.selectMode ? ` data-select="${t.id}"` : ` data-expand="${t.id}"`}>
              ${esc(t.title)}
              ${formatSnoozeBadge(t)}
            </div>
            <div class="task-hover-actions">
              ${t.isCompleted ? `<button class="task-action-btn" data-restore="${t.id}" title="완료 취소">↩</button>` : ''}
              <button class="task-action-btn" data-expand="${t.id}" title="편집">✏️</button>
              <button class="task-action-btn danger" data-delete="${t.id}" title="삭제">🗑</button>
            </div>
          </div>
          <div class="task-expand">${expandHtml}</div>
        </div>`;
    }).join('');
    html += `
      <div class="timeline-section">
        <div class="section-header">⏰ 오늘</div>
        <div class="timeline-list">${timelineHtml}</div>
      </div>`;
  }

  // Section 2: Todo list
  if (hasTodo) {
    const cards = todoTasks.map(t => renderTaskCard(t)).join('');
    html += `
      <div class="task-list-section">
        <div class="section-header">📋 할일</div>
        <div class="task-list">${cards}</div>
      </div>`;
  }

  html += `</div>`;
  return html;
}

function renderTaskCard(task) {
  const isExp   = state.expandedId === task.id;
  const draft   = getDraft(task);
  const hasAlert = !!task.alertTime;

  // Snooze badge (visible whenever snoozeUntil is in the future)
  const snoozeBadge = formatSnoozeBadge(task);
  const isOnceTask = !task.repeat || task.repeat === 'ONCE';
  const dateLabel = isOnceTask ? formatTaskDateLabel(task.targetDate) : '';
  const dateBadge = dateLabel ? `<span class="task-meta-date${dateLabel === '오늘' ? ' today' : dateLabel === '지남' ? ' past' : ''}">${dateLabel}</span>` : '';

  // Meta row (always shown if any of: alert / snooze / non-today date)
  let metaHtml = '';
  if (hasAlert || snoozeBadge || dateBadge) {
    const chIcons = (task.alertChannels || []).map(c => `<span class="task-meta-ch">${CHANNEL_ICONS[c]||''}</span>`).join('');
    const repLabel = task.repeat && task.repeat !== 'ONCE' ? `<span class="task-meta-repeat">${REPEAT_LABELS[task.repeat]}</span>` : '';
    metaHtml = `
      <div class="task-meta">
        ${dateBadge}
        ${hasAlert ? `<span class="task-meta-time">⏰ ${task.alertTime}</span>` : ''}
        ${repLabel}
        ${snoozeBadge}
        ${hasAlert ? `<span class="task-meta-channels">${chIcons}</span>` : ''}
      </div>`;
  }

  const expandHtml = isExp ? renderTaskExpand(draft) : '';

  const isSel = state.selectedIds.includes(task.id);
  const selClass = state.selectMode ? ' select-mode' + (isSel ? ' selected' : '') : '';

  return `
    <div class="task-card${isExp?' expanded':''}${selClass}" data-id="${task.id}">
      <div class="task-card-header">
        ${state.selectMode
          ? `<div class="select-circle${isSel?' selected':''}" data-select="${task.id}">${isSel?'✓':''}</div>`
          : `<div class="task-checkbox" data-complete="${task.id}">${task.isCompleted ? '✓' : ''}</div>`
        }
        <div class="task-main"${state.selectMode ? ` data-select="${task.id}"` : ` data-expand="${task.id}"`}>
          <div class="task-title">${esc(task.title)}</div>
          ${metaHtml}
        </div>
        <div class="task-hover-actions">
          <button class="task-action-btn" data-expand="${task.id}" title="편집">✏️</button>
          <button class="task-action-btn danger" data-delete="${task.id}" title="삭제">🗑</button>
        </div>
      </div>
      <div class="task-expand">
        ${expandHtml}
      </div>
    </div>`;
}

function renderTaskExpand(draft) {
  const id = draft.id;
  const hasAlert = !!draft.alertTime;

  // Time row
  let timeSection = '';
  if (hasAlert) {
    const [dh, dm] = (draft.alertTime || '09:00').split(':').map(Number);
    let repeatExtra = '';
    if (draft.repeat === 'ONCE') {
      repeatExtra = `<input type="date" class="date-input-sm" data-ed-date="${id}"
        value="${esc(draft.targetDate || todayStr())}">`;
    } else if (draft.repeat === 'WEEKLY') {
      const dChips = DAYS.map((d, i) =>
        `<span class="day-chip${draft.repeatDay===i?' active':''}" data-ed-day="${id}" data-day="${i}">${d}</span>`
      ).join('');
      repeatExtra = `<div class="day-chips" data-ed-daychips="${id}">${dChips}</div>`;
    } else if (draft.repeat === 'MONTHLY') {
      repeatExtra = `<input type="number" class="time-spinner-val" min="1" max="31"
        data-ed-mday="${id}" value="${draft.repeatDay||new Date().getDate()}" style="width:44px">`;
    }

    const chChips = Object.keys(CHANNEL_ICONS).map(ch => {
      const active = (draft.alertChannels||[]).includes(ch);
      return `<span class="channel-chip${active?' active':''}" data-ed-ch="${id}" data-ch="${ch}">
        ${CHANNEL_ICONS[ch]} ${CHANNEL_LABELS[ch]}</span>`;
    }).join('');

    timeSection = `
      <div class="expand-row">
        <span class="expand-label">시간</span>
        <div class="time-spinner">
          <button class="time-spinner-btn" data-ed-hdn="${id}">−</button>
          <input class="time-spinner-val" type="number" min="0" max="23" data-ed-hour="${id}"
            value="${String(dh).padStart(2,'0')}">
          <button class="time-spinner-btn" data-ed-hup="${id}">+</button>
        </div>
        <span class="time-colon">:</span>
        <div class="time-spinner">
          <button class="time-spinner-btn" data-ed-mdn="${id}">−</button>
          <input class="time-spinner-val" type="number" min="0" max="59" data-ed-min="${id}"
            value="${String(dm).padStart(2,'0')}">
          <button class="time-spinner-btn" data-ed-mup="${id}">+</button>
        </div>
      </div>
      <div class="expand-row">
        <span class="expand-label">반복</span>
        <select class="repeat-select" data-ed-repeat="${id}">
          <option value="ONCE"${draft.repeat==='ONCE'?' selected':''}>1회</option>
          <option value="DAILY"${draft.repeat==='DAILY'?' selected':''}>매일</option>
          <option value="WEEKLY"${draft.repeat==='WEEKLY'?' selected':''}>매주</option>
          <option value="MONTHLY"${draft.repeat==='MONTHLY'?' selected':''}>매월</option>
        </select>
        ${repeatExtra}
      </div>
      <div class="expand-row">
        <span class="expand-label">방법</span>
        <div class="channel-chips">${chChips}</div>
      </div>`;
  }

  const gcalBadge = draft.gcalEventId
    ? `<div class="gcal-badge">📅 캘린더 연동됨</div>`
    : '';

  return `
    <div class="task-expand-inner">
      <div class="expand-row">
        <span class="expand-label">제목</span>
        <input class="expand-input" type="text" data-ed-title="${id}"
          value="${esc(draft.title)}" placeholder="제목">
      </div>
      <div class="expand-row">
        <span class="expand-label">알림</span>
        <div class="radio-group">
          <label class="radio-option${!hasAlert?' selected':''}">
            <input type="radio" name="alert-${id}" value="none" data-ed-alerttoggle="${id}"
              ${!hasAlert?'checked':''}> 없음
          </label>
          <label class="radio-option${hasAlert?' selected':''}">
            <input type="radio" name="alert-${id}" value="on" data-ed-alerttoggle="${id}"
              ${hasAlert?'checked':''}> 있음
          </label>
        </div>
      </div>
      ${timeSection}
      <div class="expand-row">
        <span class="expand-label">메모</span>
        <textarea class="expand-textarea" data-ed-memo="${id}"
          placeholder="메모...">${esc(draft.memo||'')}</textarea>
      </div>
      ${gcalBadge}
      <div class="expand-actions">
        <button class="btn btn-primary" data-save="${id}">저장</button>
        <button class="btn btn-danger" data-delete="${id}">삭제</button>
      </div>
    </div>`;
}

function bindTaskListEvents(container) {
  // Delegated event handling on the task list
  container.addEventListener('click', e => {
    // ── Select mode: clicking card or select-circle toggles selection ──────
    if (state.selectMode) {
      const selectEl = e.target.closest('[data-select]');
      if (selectEl) {
        const id = selectEl.dataset.select;
        const idx = state.selectedIds.indexOf(id);
        if (idx > -1) state.selectedIds.splice(idx, 1);
        else state.selectedIds.push(id);
        // Update DOM directly to preserve scroll position
        const card = container.querySelector(`[data-id="${id}"]`);
        if (card) {
          const sel = state.selectedIds.includes(id);
          card.classList.toggle('selected', sel);
          const circle = card.querySelector('.select-circle');
          if (circle) {
            circle.classList.toggle('selected', sel);
            circle.textContent = sel ? '✓' : '';
          }
        }
        updateBulkBar();
        return;
      }
      return; // Block all other actions in select mode
    }

    // Complete checkbox (task card OR timeline check)
    const completeEl = e.target.closest('[data-complete]');
    if (completeEl) {
      e.stopPropagation();
      const task = state.tasks.find(t => t.id === completeEl.dataset.complete);
      if (task && !task.isCompleted) {
        completeTask(completeEl.dataset.complete);
      } else if (task && task.isCompleted) {
        // Click checkmark on completed task → undo
        restoreTask(completeEl.dataset.complete);
      }
      return;
    }

    // Restore completed task
    const restoreEl = e.target.closest('[data-restore]');
    if (restoreEl) {
      e.stopPropagation();
      restoreTask(restoreEl.dataset.restore);
      return;
    }

    // Expand / collapse (task card titles OR timeline titles)
    const expandEl = e.target.closest('[data-expand]');
    if (expandEl) {
      const id = expandEl.dataset.expand;
      toggleExpand(id);
      return;
    }

    // Save
    const saveEl = e.target.closest('[data-save]');
    if (saveEl) {
      e.stopPropagation();
      saveExpandedTask(saveEl.dataset.save);
      return;
    }

    // Delete
    const deleteEl = e.target.closest('[data-delete]');
    if (deleteEl) {
      e.stopPropagation();
      confirmDeleteTask(deleteEl.dataset.delete);
      return;
    }

    // Alert toggle radio
    const alertToggle = e.target.closest('[data-ed-alerttoggle]');
    if (alertToggle && alertToggle.tagName === 'INPUT') {
      const id = alertToggle.dataset.edAlerttoggle;
      const val = alertToggle.value;
      if (val === 'none') {
        setDraft(id, { alertTime: null });
      } else {
        setDraft(id, { alertTime: '09:00', repeat: 'ONCE', targetDate: todayStr() });
      }
      rerenderExpandedCard(id);
      return;
    }

    // Hour/min +/- buttons in expand
    const hudEl = e.target.closest('[data-ed-hup]');
    if (hudEl) { e.stopPropagation(); changeExpandHour(hudEl.dataset.edHup, 1); return; }
    const hddEl = e.target.closest('[data-ed-hdn]');
    if (hddEl) { e.stopPropagation(); changeExpandHour(hddEl.dataset.edHdn, -1); return; }
    const mudEl = e.target.closest('[data-ed-mup]');
    if (mudEl) { e.stopPropagation(); changeExpandMin(mudEl.dataset.edMup, 5); return; }
    const mddEl = e.target.closest('[data-ed-mdn]');
    if (mddEl) { e.stopPropagation(); changeExpandMin(mddEl.dataset.edMdn, -5); return; }

    // Day chips
    const dcEl = e.target.closest('[data-ed-day]');
    if (dcEl) {
      e.stopPropagation();
      const id = dcEl.dataset.edDay;
      const day = parseInt(dcEl.dataset.day);
      setDraft(id, { repeatDay: day });
      rerenderExpandedCard(id);
      return;
    }

    // Channel chips
    const chEl = e.target.closest('[data-ed-ch]');
    if (chEl) {
      e.stopPropagation();
      const id = chEl.dataset.edCh;
      const ch = chEl.dataset.ch;
      const draft = getDraft({ id, alertChannels: [] });
      const channels = (getDraft(state.tasks.find(t=>t.id===id)||{alertChannels:[]}).alertChannels || []).slice();
      const idx = channels.indexOf(ch);
      if (idx > -1) channels.splice(idx,1); else channels.push(ch);
      setDraft(id, { alertChannels: channels });
      rerenderExpandedCard(id);
      return;
    }
  });

  // Change events (inputs, selects, textareas)
  container.addEventListener('change', e => {
    const t = e.target;

    if (t.dataset.edTitle) {
      setDraft(t.dataset.edTitle, { title: t.value });
      return;
    }
    if (t.dataset.edHour) {
      const id = t.dataset.edHour;
      const d = getDraft(state.tasks.find(x=>x.id===id)||{alertTime:'09:00'});
      const [_, mm] = (d.alertTime||'09:00').split(':');
      setDraft(id, { alertTime: `${String(Math.max(0,Math.min(23,parseInt(t.value)||0))).padStart(2,'0')}:${mm}` });
      return;
    }
    if (t.dataset.edMin) {
      const id = t.dataset.edMin;
      const d = getDraft(state.tasks.find(x=>x.id===id)||{alertTime:'09:00'});
      const [hh] = (d.alertTime||'09:00').split(':');
      setDraft(id, { alertTime: `${hh}:${String(Math.max(0,Math.min(59,parseInt(t.value)||0))).padStart(2,'0')}` });
      return;
    }
    if (t.dataset.edRepeat) {
      const id = t.dataset.edRepeat;
      const val = t.value;
      const extra = {};
      if (val === 'WEEKLY')  extra.repeatDay = new Date().getDay();
      if (val === 'MONTHLY') extra.repeatDay = new Date().getDate();
      setDraft(id, { repeat: val, ...extra });
      rerenderExpandedCard(id);
      return;
    }
    if (t.dataset.edDate) {
      setDraft(t.dataset.edDate, { targetDate: t.value });
      return;
    }
    if (t.dataset.edMday) {
      const v = Math.max(1, Math.min(31, parseInt(t.value)||1));
      setDraft(t.dataset.edMday, { repeatDay: v });
      return;
    }
    if (t.dataset.edMemo) {
      setDraft(t.dataset.edMemo, { memo: t.value });
      return;
    }
  });

  container.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.edTitle) { setDraft(t.dataset.edTitle, { title: t.value }); }
    if (t.dataset.edMemo)  { setDraft(t.dataset.edMemo,  { memo:  t.value }); }
  });
}

function toggleExpand(id) {
  if (state.expandedId === id) {
    state.expandedId = null;
  } else {
    state.expandedId = id;
    // Initialize draft from task
    const task = state.tasks.find(t => t.id === id);
    if (task && !state.expandEdits[id]) {
      state.expandEdits[id] = {};
    }
  }
  updateMainContent();
}

function changeExpandHour(id, delta) {
  const task = state.tasks.find(x => x.id === id);
  if (!task) return;
  const d = getDraft(task);
  const [hh, mm] = (d.alertTime || '09:00').split(':');
  const newH = (parseInt(hh) + delta + 24) % 24;
  setDraft(id, { alertTime: `${String(newH).padStart(2,'0')}:${mm}` });
  // Update input value directly
  const inp = document.querySelector(`[data-ed-hour="${id}"]`);
  if (inp) inp.value = String(newH).padStart(2,'0');
}

function changeExpandMin(id, delta) {
  const task = state.tasks.find(x => x.id === id);
  if (!task) return;
  const d = getDraft(task);
  const [hh, mm] = (d.alertTime || '09:00').split(':');
  const newM = (parseInt(mm) + delta + 60) % 60;
  setDraft(id, { alertTime: `${hh}:${String(newM).padStart(2,'0')}` });
  const inp = document.querySelector(`[data-ed-min="${id}"]`);
  if (inp) inp.value = String(newM).padStart(2,'0');
}

function rerenderExpandedCard(id) {
  const card = document.querySelector(`.task-card[data-id="${id}"]`);
  if (!card) return;
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  const draft = getDraft(task);
  const expandDiv = card.querySelector('.task-expand');
  if (expandDiv) {
    expandDiv.innerHTML = renderTaskExpand(draft);
  }
}

async function completeTask(id) {
  try {
    const hadGcal = !!state.tasks.find(t => t.id === id)?.gcalEventId;
    state.tasks = await window.timeping.completeTask(id);
    if (state.expandedId === id) state.expandedId = null;
    updateMainContent();
    showToast('완료!');
    if (hadGcal) {
      setTimeout(() => showToast('🗑 구글 캘린더에서 삭제됐어요'), 2700);
    }
  } catch (e) {
    showToast('오류: ' + e.message, 'error');
  }
}

async function restoreTask(id) {
  try {
    state.tasks = await window.timeping.restoreTask(id);
    updateMainContent();
    showToast('↩ 복구되었습니다');
  } catch (e) {
    showToast('오류: ' + e.message, 'error');
  }
}

function confirmDeleteTask(id) {
  const task = state.tasks.find(t => t.id === id);
  const title = task ? task.title : '';
  showConfirm('할일 삭제', `"${title}" 을(를) 삭제하시겠습니까?`, async () => {
    try {
      state.tasks = await window.timeping.deleteTask(id);
      if (state.expandedId === id) state.expandedId = null;
      delete state.expandEdits[id];
      updateMainContent();
      showToast('삭제되었습니다');
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
    }
  });
}

async function saveExpandedTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  const draft = getDraft(task);

  // Validate
  if (!draft.title || !draft.title.trim()) {
    showToast('제목을 입력하세요', 'error');
    return;
  }

  const updated = Object.assign({}, task, draft, {
    updatedAt: new Date().toISOString(),
  });

  // Clean up null alertTime
  if (!updated.alertTime) {
    updated.alertTime = null;
  }

  try {
    state.tasks = await window.timeping.saveTask(updated);
    delete state.expandEdits[id];
    state.expandedId = null;
    updateMainContent();
    showToast('저장되었습니다');
  } catch (e) {
    showToast('저장 실패: ' + e.message, 'error');
  }
}

// ─── Bulk Select / Delete ─────────────────────────────────────────────────────
function updateBulkBar() {
  let bar = document.getElementById('bulk-action-bar');
  const app = document.getElementById('app');
  if (!app) return;

  if (state.selectMode && state.selectedIds.length > 0) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bulk-action-bar';
      bar.className = 'bulk-action-bar';
      app.appendChild(bar);
    }
    // Get all visible selectable IDs from current DOM
    const visibleIds = [...document.querySelectorAll('#main-content [data-id]')].map(el => el.dataset.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => state.selectedIds.includes(id));

    bar.innerHTML = `
      <button class="bulk-select-all-btn" id="bulk-select-all">${allSelected ? '선택 해제' : '전체 선택'}</button>
      <span class="bulk-count">${state.selectedIds.length}개 선택됨</span>
      <button class="bulk-delete-btn" id="bulk-delete-confirm">🗑 삭제</button>
    `;

    document.getElementById('bulk-select-all').addEventListener('click', () => {
      const vIds = [...document.querySelectorAll('#main-content [data-id]')].map(el => el.dataset.id);
      const allSel = vIds.every(id => state.selectedIds.includes(id));
      if (allSel) {
        state.selectedIds = [];
      } else {
        vIds.forEach(id => { if (!state.selectedIds.includes(id)) state.selectedIds.push(id); });
      }
      updateMainContent();
      updateBulkBar();
    });

    document.getElementById('bulk-delete-confirm').addEventListener('click', bulkDelete);

  } else if (bar) {
    bar.remove();
  }
}

async function bulkDelete() {
  if (state.selectedIds.length === 0) return;
  const count = state.selectedIds.length;
  showConfirm('일괄 삭제', `선택한 ${count}개 항목을 삭제하시겠습니까?`, async () => {
    try {
      const ids = [...state.selectedIds];
      for (const id of ids) {
        state.tasks = await window.timeping.deleteTask(id);
        delete state.expandEdits[id];
        if (state.expandedId === id) state.expandedId = null;
      }
      state.selectedIds = [];
      state.selectMode = false;
      updateFilterSection();
      updateMainContent();
      updateBulkBar();
      showToast(`${count}개 삭제되었습니다`);
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
    }
  });
}

// ─── Date helper ──────────────────────────────────────────────────────────────
function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── Calendar / Date Navigator View ──────────────────────────────────────────
function appearsOnDate(task, ds) {
  if (!task.alertTime) return false;
  if (!task.repeat || task.repeat === 'ONCE') return (task.targetDate || todayStr()) === ds;
  if (task.repeat === 'DAILY') return true;
  const d = new Date(ds + 'T00:00:00');
  if (task.repeat === 'WEEKLY')  return task.repeatDay === d.getDay();
  if (task.repeat === 'MONTHLY') return task.repeatDay === d.getDate();
  return false;
}

function renderCalendarView() {
  const today    = todayStr();
  const selected = state.calDate || today;
  const selDate  = new Date(selected + 'T00:00:00');

  // 9-day strip: -3 … +5 relative to selected
  const days = [];
  for (let i = -3; i <= 5; i++) {
    const d = new Date(selDate);
    d.setDate(d.getDate() + i);
    const ds = dateStr(d);
    days.push({ ds, d, isToday: ds === today, isSelected: ds === selected });
  }

  const allTasks = [...new Map(state.tasks.map(t => [t.id, t])).values()];

  // Day strip
  const dayNames = ['일','월','화','수','목','금','토'];
  const dayStripHtml = days.map(({ ds, d, isToday, isSelected }) => {
    const hasTasks = allTasks.some(t => !t.isCompleted && appearsOnDate(t, ds));
    return `
      <div class="cal-day${isSelected ? ' selected' : ''}${isToday ? ' today' : ''}" data-caldate="${ds}">
        <div class="cal-day-name">${dayNames[d.getDay()]}</div>
        <div class="cal-day-num">${d.getDate()}</div>
        ${hasTasks ? '<span class="cal-dot"></span>' : '<span class="cal-dot-empty"></span>'}
      </div>`;
  }).join('');

  // Tasks for selected date (incomplete + completed on that date)
  let dateTasks = allTasks.filter(t => {
    if (t.isCompleted) return (t.completedAt || '').slice(0, 10) === selected;
    return appearsOnDate(t, selected);
  });
  dateTasks.sort((a, b) => (a.alertTime || '99:99').localeCompare(b.alertTime || '99:99'));

  const selLabel = (() => {
    const mo = selDate.getMonth() + 1;
    const dd = selDate.getDate();
    const dow = ['일','월','화','수','목','금','토'][selDate.getDay()];
    const suffix = selected === today ? ' (오늘)' : '';
    return `${selDate.getFullYear()}년 ${mo}월 ${dd}일 ${dow}요일${suffix}`;
  })();

  const taskListHtml = dateTasks.length === 0
    ? `<div class="empty-state" style="height:140px">
         <div class="empty-state-icon">📅</div>
         <div class="empty-state-text">이 날 일정이 없습니다</div>
       </div>`
    : dateTasks.map(t => {
        const isExp  = state.expandedId === t.id;
        const draft  = getDraft(t);
        const repBadge = t.repeat && t.repeat !== 'ONCE'
          ? `<span class="cal-repeat-badge">${REPEAT_LABELS[t.repeat]}</span>` : '';
        const expandHtml = isExp ? renderTaskExpand(draft) : '';
        return `
          <div class="cal-task-item${t.isCompleted ? ' done' : ''}${isExp ? ' expanded' : ''}" data-id="${t.id}">
            <div class="cal-task-row">
              <div class="timeline-check${t.isCompleted ? ' checked' : ''}" data-complete="${t.id}">
                ${t.isCompleted ? '✓' : ''}
              </div>
              <div class="cal-task-time">${t.alertTime || '–'}</div>
              <div class="cal-task-title" data-expand="${t.id}">${esc(t.title)}${repBadge}</div>
              <div class="task-hover-actions">
                <button class="task-action-btn" data-expand="${t.id}" title="편집">✏️</button>
                <button class="task-action-btn danger" data-delete="${t.id}" title="삭제">🗑</button>
              </div>
            </div>
            <div class="task-expand">${expandHtml}</div>
          </div>`;
      }).join('');

  const isToday = selected === today;
  return `
    <div class="calendar-view">
      <div class="cal-nav">
        <button class="cal-nav-btn" id="cal-prev" title="하루 전">‹</button>
        <div class="cal-strip">${dayStripHtml}</div>
        <button class="cal-nav-btn" id="cal-next" title="하루 후">›</button>
        ${!isToday ? `<button class="cal-today-btn" id="cal-goto-today">오늘</button>` : ''}
      </div>
      <div class="cal-date-label">
        <span>${selLabel}</span>
        <input type="date" class="cal-date-picker" id="cal-date-picker" value="${selected}" title="날짜 선택">
      </div>
      <div class="cal-task-list">${taskListHtml}</div>
    </div>`;
}

function bindCalendarEvents(container) {
  container.addEventListener('click', e => {
    if (e.target.closest('#cal-prev')) {
      const base = state.calDate || todayStr();
      const d = new Date(base.slice(0,4), parseInt(base.slice(5,7))-1, parseInt(base.slice(8,10)));
      d.setDate(d.getDate() - 1);
      state.calDate = dateStr(d);
      state.expandedId = null;
      updateMainContent();
      return;
    }
    if (e.target.closest('#cal-next')) {
      const base = state.calDate || todayStr();
      const d = new Date(base.slice(0,4), parseInt(base.slice(5,7))-1, parseInt(base.slice(8,10)));
      d.setDate(d.getDate() + 1);
      state.calDate = dateStr(d);
      state.expandedId = null;
      updateMainContent();
      return;
    }
    if (e.target.closest('#cal-goto-today')) {
      state.calDate = todayStr();
      state.expandedId = null;
      updateMainContent();
      return;
    }
    const dayEl = e.target.closest('[data-caldate]');
    if (dayEl && !dayEl.closest('#cal-date-picker')) {
      state.calDate = dayEl.dataset.caldate;
      state.expandedId = null;
      updateMainContent();
      return;
    }
  });
  // Date picker
  const picker = container.querySelector('#cal-date-picker');
  if (picker) {
    picker.addEventListener('change', e => {
      if (e.target.value) {
        state.calDate = e.target.value;
        state.expandedId = null;
        updateMainContent();
      }
    });
  }
  // Reuse full task-list event delegation for complete / expand / save / delete
  bindTaskListEvents(container);
}

// ─── History Export Helpers ───────────────────────────────────────────────────
function quarterStartStr() {
  const now = new Date();
  const qMonth = Math.floor(now.getMonth() / 3) * 3;
  return `${now.getFullYear()}-${String(qMonth + 1).padStart(2, '0')}-01`;
}

function escapeCsvCell(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsvData(tasks) {
  const REPEAT_KO = { ONCE: '1회', DAILY: '매일', WEEKLY: '매주', MONTHLY: '매월' };
  const headers = ['완료일자', '완료시각', '제목', '메모', '알림시간', '반복', '유형'];
  const rows = tasks.map(t => {
    const ts = t.completedAt || t.updatedAt || '';
    const date = ts ? ts.slice(0, 10) : '';
    const time = ts ? formatCompletedAt(ts) : '';
    const type = t.alertTime ? '알림' : '할일';
    return [
      date,
      time,
      t.title || '',
      t.memo || '',
      t.alertTime || '',
      REPEAT_KO[t.repeat] || '1회',
      type,
    ].map(escapeCsvCell).join(',');
  });
  return [headers.join(','), ...rows].join('\r\n');
}

async function exportHistory() {
  const from = state.historyFrom || quarterStartStr();
  const to   = state.historyTo   || todayStr();

  const tasks = state.tasks.filter(t => {
    if (!t.isCompleted) return false;
    const ds = (t.completedAt || t.updatedAt || '').slice(0, 10);
    return ds >= from && ds <= to;
  });

  if (tasks.length === 0) {
    showToast('해당 기간에 완료된 항목이 없습니다', 'error');
    return;
  }

  // Sort by date asc
  tasks.sort((a, b) => (a.completedAt || a.updatedAt || '').localeCompare(b.completedAt || b.updatedAt || ''));

  const csv = buildCsvData(tasks);
  const filename = `성과기록_${from}_${to}.csv`;

  const result = await window.timeping.exportCsv(csv, filename);
  if (result.success) {
    showToast(`✅ ${tasks.length}개 항목을 내보냈습니다`);
  } else if (result.error) {
    showToast('내보내기 실패: ' + result.error, 'error');
  }
}

// ─── History View ─────────────────────────────────────────────────────────────
function historyGroupLabel(ds) {
  const today = todayStr();
  const yesterday = (() => {
    const d = new Date(); d.setDate(d.getDate()-1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  })();
  if (ds === yesterday) return '어제';
  if (isThisWeek(ds))   return '이번 주';
  return ds.slice(0, 7).replace('-', '년 ') + '월';
}

function renderHistoryListHtml() {
  // Exclude today's completed tasks (they stay in the timeline)
  let completed = state.tasks.filter(t => {
    if (!t.isCompleted) return false;
    const completedDate = (t.completedAt || t.updatedAt || '').slice(0, 10);
    return completedDate < todayStr();
  });

  // Apply date range filter if set
  if (state.historyFrom) {
    completed = completed.filter(t =>
      (t.completedAt || t.updatedAt || '').slice(0, 10) >= state.historyFrom
    );
  }
  if (state.historyTo) {
    completed = completed.filter(t =>
      (t.completedAt || t.updatedAt || '').slice(0, 10) <= state.historyTo
    );
  }

  if (state.historySearch) {
    const q = state.historySearch.toLowerCase();
    completed = completed.filter(t => t.title.toLowerCase().includes(q));
  }

  if (completed.length === 0) {
    return `
      <div class="empty-state" style="margin-top:40px">
        <div class="empty-state-icon">🕐</div>
        <div class="empty-state-text">${state.historySearch ? '검색 결과가 없습니다' : '완료된 할일이 없습니다'}</div>
      </div>`;
  }

  // Sort newest first
  completed.sort((a, b) => (b.completedAt || b.updatedAt || '').localeCompare(a.completedAt || a.updatedAt || ''));

  // Group by date
  const groups = {};
  completed.forEach(t => {
    const ts = t.completedAt || t.updatedAt || '';
    const ds = ts ? ts.slice(0, 10) : 'unknown';
    if (!groups[ds]) groups[ds] = [];
    groups[ds].push(t);
  });

  const groupKeys = Object.keys(groups).sort().reverse();
  return groupKeys.map(ds => {
    const items = groups[ds].map(t => `
      <div class="history-item">
        <span class="history-check">✓</span>
        <span class="history-title">${esc(t.title)}</span>
        <span class="history-time">${formatCompletedAt(t.completedAt)}</span>
        <button class="history-delete-btn" data-delete="${t.id}" title="삭제">✕</button>
      </div>`).join('');
    return `
      <div class="history-date-group">
        <div class="history-date-label">${esc(historyGroupLabel(ds))}</div>
        ${items}
      </div>`;
  }).join('');
}

function updateHistoryList() {
  const el = document.getElementById('history-list-content');
  if (!el) return;
  el.innerHTML = renderHistoryListHtml();
}

function renderHistoryView() {
  const qStart = quarterStartStr();
  const today  = todayStr();
  const from = state.historyFrom || '';
  const to   = state.historyTo   || '';

  return `
    <div class="history-view">
      <div class="history-search-bar">
        <input class="history-search-input" id="history-search" type="text"
          placeholder="완료된 할일 검색..." value="${esc(state.historySearch)}" autocomplete="off">
      </div>
      <div class="history-export-bar">
        <div class="export-range-row">
          <span class="export-range-label">기간</span>
          <input class="export-date-input" type="date" id="export-from" value="${esc(from)}" max="${today}">
          <span class="export-range-sep">~</span>
          <input class="export-date-input" type="date" id="export-to"   value="${esc(to)}"   max="${today}">
          <button class="export-preset-btn" id="export-preset-quarter">이번 분기</button>
          <button class="export-preset-btn" id="export-preset-clear">전체</button>
        </div>
        <button class="export-btn" id="export-btn">📊 엑셀로 내보내기</button>
      </div>
      <div id="history-list-content" class="history-list">
        ${renderHistoryListHtml()}
      </div>
    </div>`;
}

function bindHistoryEvents(container) {
  const inp = container.querySelector('#history-search');
  if (inp) {
    inp.addEventListener('input', e => {
      state.historySearch = e.target.value;
      updateHistoryList();
    });
    inp.focus();
  }

  // Date range inputs
  const fromEl = container.querySelector('#export-from');
  const toEl   = container.querySelector('#export-to');
  if (fromEl) {
    fromEl.addEventListener('change', e => {
      state.historyFrom = e.target.value || null;
      updateHistoryList();
    });
  }
  if (toEl) {
    toEl.addEventListener('change', e => {
      state.historyTo = e.target.value || null;
      updateHistoryList();
    });
  }

  // Preset: 이번 분기
  const qBtn = container.querySelector('#export-preset-quarter');
  if (qBtn) {
    qBtn.addEventListener('click', () => {
      state.historyFrom = quarterStartStr();
      state.historyTo   = todayStr();
      if (fromEl) fromEl.value = state.historyFrom;
      if (toEl)   toEl.value   = state.historyTo;
      updateHistoryList();
    });
  }

  // Preset: 전체 (clear)
  const clrBtn = container.querySelector('#export-preset-clear');
  if (clrBtn) {
    clrBtn.addEventListener('click', () => {
      state.historyFrom = null;
      state.historyTo   = null;
      if (fromEl) fromEl.value = '';
      if (toEl)   toEl.value   = '';
      updateHistoryList();
    });
  }

  // Export button
  const expBtn = container.querySelector('#export-btn');
  if (expBtn) {
    expBtn.addEventListener('click', exportHistory);
  }

  // Delete button in history items
  container.addEventListener('click', e => {
    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) {
      e.stopPropagation();
      confirmDeleteTask(delBtn.dataset.delete);
    }
  });
}

// ─── Settings View ────────────────────────────────────────────────────────────
function renderSettingsView() {
  const s = state.settings;
  const tab = state.settingsTab;

  const tabs = [
    { key: 'general', label: '일반' },
    { key: 'email',   label: '이메일' },
    { key: 'gcal',    label: '구글 캘린더' },
  ].map(t => `<div class="settings-tab${tab===t.key?' active':''}" data-stab="${t.key}">${t.label}</div>`).join('');

  let content = '';
  if (tab === 'general')  content = renderSettingsGeneral(s);
  if (tab === 'email')    content = renderSettingsEmail(s);
  if (tab === 'gcal')     content = renderSettingsGcal(s);

  return `
    <div class="settings-view">
      <div class="settings-tabs" id="settings-tabs">${tabs}</div>
      <div class="settings-content">${content}</div>
    </div>`;
}

function renderSettingsGeneral(s) {
  const realertVal = s.realertIntervalMin ?? 3;   // default 3min
  const realertOptions = [
    { v: 0,   label: '재알림 끄기' },
    { v: 1,   label: '1분마다' },
    { v: 3,   label: '3분마다 (기본)' },
    { v: 5,   label: '5분마다' },
    { v: 10,  label: '10분마다' },
    { v: 30,  label: '30분마다' },
    { v: 60,  label: '1시간마다' },
  ].map(o => `<option value="${o.v}"${o.v === realertVal ? ' selected' : ''}>${o.label}</option>`).join('');

  return `
    <div class="settings-section">
      <div class="settings-section-title">앱 설정</div>
      <div class="setting-row">
        <div>
          <div class="setting-label">시작 시 자동 실행</div>
          <div class="setting-sublabel">로그인 시 까먹지 말자를 자동으로 시작합니다</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="launch-at-login" ${s.launchAtLogin?'checked':''}>
          <span class="toggle-track"></span>
        </label>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">알림 동작</div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch">
        <div>
          <div class="setting-label">미응답 시 재알림 간격</div>
          <div class="setting-sublabel">알림창을 그냥 닫거나 무시했을 때 다시 알리는 주기</div>
        </div>
        <select class="setting-select" id="realert-interval" style="margin-top:6px">
          ${realertOptions}
        </select>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">구글 캘린더 동기화</div>
      <div class="setting-row">
        <div>
          <div class="setting-label">완료해도 구글 캘린더에서 삭제하지 않기</div>
          <div class="setting-sublabel">기본은 완료 시 캘린더에서 삭제됨. 켜두면 기록용으로 캘린더에 남아있음</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="keep-gcal-on-complete" ${s.keepGcalOnComplete?'checked':''}>
          <span class="toggle-track"></span>
        </label>
      </div>
    </div>`;
}

function renderSettingsEmail(s) {
  const smtp = s.smtp || {};
  const presetOpts = ['', 'gmail', 'naver', 'outlook'].map(p =>
    `<option value="${p}"${smtp.preset===p?' selected':''}>${p||'직접 입력'}</option>`
  ).join('');

  return `
    <div class="settings-section">
      <div class="settings-section-title">SMTP 이메일 설정</div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch">
        <div class="setting-col-label">프리셋</div>
        <select class="setting-select" id="smtp-preset" style="margin-top:4px">
          ${presetOpts}
        </select>
      </div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch">
        <div class="setting-col-label">SMTP 서버</div>
        <input class="setting-input" id="smtp-host" type="text" value="${esc(smtp.host||'')}" placeholder="smtp.example.com" style="margin-top:4px">
      </div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch">
        <div class="setting-col-label">포트</div>
        <input class="setting-input" id="smtp-port" type="number" value="${esc(smtp.port||587)}" placeholder="587" style="margin-top:4px">
      </div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch">
        <div class="setting-col-label">사용자 이름</div>
        <input class="setting-input" id="smtp-user" type="text" value="${esc(smtp.user||'')}" placeholder="user@example.com" style="margin-top:4px">
      </div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch">
        <div class="setting-col-label">비밀번호</div>
        <input class="setting-input" id="smtp-pass" type="password" value="${esc(smtp.pass||'')}" placeholder="앱 비밀번호" style="margin-top:4px">
      </div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch">
        <div class="setting-col-label">받는 사람 이메일</div>
        <input class="setting-input" id="smtp-to" type="email" value="${esc(smtp.to||'')}" placeholder="you@example.com" style="margin-top:4px">
      </div>
      <div class="setting-row" style="gap:8px;justify-content:flex-end">
        <button class="settings-btn" id="smtp-test">연결 테스트</button>
        <button class="settings-btn success-btn" id="smtp-save">저장</button>
      </div>
    </div>`;
}

function renderSettingsGcal(s) {
  const gc = state.gcalStatus;
  const connected = gc && gc.authenticated;
  const cfg = state.gcalConfig || { client_id: '', hasSecret: false };

  if (connected) {
    const calOptions = (state.gcalCalendars || []).map(c =>
      `<option value="${esc(c.id)}"${s.gcalCalendarId===c.id?' selected':''}>${esc(c.summary)}</option>`
    ).join('');

    return `
      <div class="settings-section">
        <div class="settings-section-title">구글 캘린더 연동</div>
        <div class="gcal-connected-card">
          <div class="gcal-connected-icon">✅</div>
          <div class="gcal-connected-info">
            <div class="gcal-connected-label">연결됨</div>
            <div class="gcal-connected-email">${esc(gc.user && gc.user.email ? gc.user.email : (typeof gc.user === 'string' ? gc.user : ''))}</div>
          </div>
          <button class="settings-btn danger" id="gcal-revoke">해제</button>
        </div>
        ${calOptions ? `
        <div class="setting-row" style="flex-direction:column;align-items:stretch;margin-top:8px">
          <div class="setting-label" style="margin-bottom:6px">동기화 캘린더</div>
          <select class="setting-select" id="gcal-calendar">${calOptions}</select>
        </div>` : ''}
        <div style="margin-top:12px">
          <button class="settings-btn" id="gcal-sync-now">↻ 지금 동기화</button>
        </div>
      </div>`;
  }

  return `
    <div class="settings-section">
      <div class="settings-section-title">구글 캘린더 연동</div>
      <div style="color:var(--text-muted);font-size:12px;margin-bottom:14px;line-height:1.6">
        Google 계정으로 로그인하면 일정이 자동으로 양방향 동기화됩니다.
      </div>
      <button class="gcal-signin-btn" id="gcal-connect">
        <span class="gcal-google-icon">G</span> Google로 로그인
      </button>
    </div>`;
}

function bindSettingsEvents(container) {
  // Tab switching
  const tabBar = container.querySelector('#settings-tabs');
  if (tabBar) {
    tabBar.addEventListener('click', e => {
      const tab = e.target.closest('[data-stab]');
      if (tab) {
        state.settingsTab = tab.dataset.stab;
        updateMainContent();
      }
    });
  }

  // General: launch at login
  const llToggle = container.querySelector('#launch-at-login');
  if (llToggle) {
    llToggle.addEventListener('change', async () => {
      state.settings.launchAtLogin = llToggle.checked;
      try {
        await window.timeping.saveSettings(state.settings);
      } catch(e) {}
    });
  }

  // Re-alert interval (0 = off)
  const realertSel = container.querySelector('#realert-interval');
  if (realertSel) {
    realertSel.addEventListener('change', async () => {
      state.settings.realertIntervalMin = Number(realertSel.value);
      try {
        await window.timeping.saveSettings(state.settings);
      } catch(e) {}
    });
  }

  // Keep gcal event on complete
  const keepGcalToggle = container.querySelector('#keep-gcal-on-complete');
  if (keepGcalToggle) {
    keepGcalToggle.addEventListener('change', async () => {
      state.settings.keepGcalOnComplete = keepGcalToggle.checked;
      try {
        await window.timeping.saveSettings(state.settings);
      } catch(e) {}
    });
  }

  // SMTP preset
  const presetSel = container.querySelector('#smtp-preset');
  if (presetSel) {
    presetSel.addEventListener('change', () => {
      const p = presetSel.value;
      if (SMTP_PRESETS[p]) {
        const hostEl = container.querySelector('#smtp-host');
        const portEl = container.querySelector('#smtp-port');
        if (hostEl) hostEl.value = SMTP_PRESETS[p].host;
        if (portEl) portEl.value = SMTP_PRESETS[p].port;
        state.settings.smtp = Object.assign({}, state.settings.smtp, { preset: p, ...SMTP_PRESETS[p] });
      } else {
        state.settings.smtp = Object.assign({}, state.settings.smtp, { preset: '' });
      }
    });
  }

  // SMTP test
  const smtpTest = container.querySelector('#smtp-test');
  if (smtpTest) {
    smtpTest.addEventListener('click', async () => {
      collectSmtpSettings(container);
      smtpTest.textContent = '테스트 중...';
      smtpTest.disabled = true;
      try {
        const result = await window.timeping.testSmtp(state.settings.smtp);
        if (result.ok) showToast('연결 성공!');
        else showToast('연결 실패: ' + (result.error || ''), 'error');
      } catch (e) {
        showToast('오류: ' + e.message, 'error');
      } finally {
        smtpTest.textContent = '연결 테스트';
        smtpTest.disabled = false;
      }
    });
  }

  // SMTP save
  const smtpSave = container.querySelector('#smtp-save');
  if (smtpSave) {
    smtpSave.addEventListener('click', async () => {
      collectSmtpSettings(container);
      try {
        state.settings = await window.timeping.saveSettings(state.settings);
        showToast('저장되었습니다');
      } catch (e) {
        showToast('저장 실패: ' + e.message, 'error');
      }
    });
  }

  // GCal connect — 바로 로그인
  const gcalConnect = container.querySelector('#gcal-connect');
  if (gcalConnect) {
    gcalConnect.addEventListener('click', async () => {
      gcalConnect.innerHTML = '<span class="gcal-google-icon">G</span> 브라우저 열림…';
      gcalConnect.disabled = true;
      try {
        const result = await window.timeping.gcalAuthorize();
        if (result.ok) {
          state.gcalStatus    = await window.timeping.gcalStatus();
          state.gcalCalendars = result.calendars || [];
          state.gcalConfig    = await window.timeping.gcalGetConfig();
          showToast('✅ Google 캘린더 연결됨');
          updateMainContent();
        } else {
          showToast('연결 실패: ' + (result.error || ''), 'error');
          gcalConnect.innerHTML = '<span class="gcal-google-icon">G</span> Google로 로그인';
          gcalConnect.disabled = false;
        }
      } catch (e) {
        showToast('오류: ' + e.message, 'error');
        gcalConnect.innerHTML = '<span class="gcal-google-icon">G</span> Google로 로그인';
        gcalConnect.disabled = false;
      }
    });
  }

  // GCal sync now
  const gcalSyncNow = container.querySelector('#gcal-sync-now');
  if (gcalSyncNow) {
    gcalSyncNow.addEventListener('click', async () => {
      gcalSyncNow.textContent = '동기화 중...';
      gcalSyncNow.disabled = true;
      try {
        const result = await window.timeping.gcalSyncAll();
        if (result.ok) {
          const parts = [];
          if (result.exported > 0) parts.push(`↑${result.exported}개 내보냄`);
          if (result.imported > 0) parts.push(`↓${result.imported}개 가져옴`);
          if (result.failed > 0)   parts.push(`⚠ ${result.failed}개 실패`);
          showToast(`동기화 완료${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
        } else {
          showToast('동기화 실패: ' + (result.error || ''), 'error');
        }
      } catch (e) {
        showToast('오류: ' + e.message, 'error');
      } finally {
        gcalSyncNow.textContent = '↻ 지금 동기화';
        gcalSyncNow.disabled = false;
      }
    });
  }

  // GCal revoke
  const gcalRevoke = container.querySelector('#gcal-revoke');
  if (gcalRevoke) {
    gcalRevoke.addEventListener('click', async () => {
      try {
        await window.timeping.gcalRevoke();
        state.gcalStatus = { authenticated: false };
        showToast('연결이 해제되었습니다');
        updateMainContent();
      } catch (e) {
        showToast('오류: ' + e.message, 'error');
      }
    });
  }

  // GCal calendar select
  const gcalCal = container.querySelector('#gcal-calendar');
  if (gcalCal) {
    gcalCal.addEventListener('change', async () => {
      const id = gcalCal.value;
      try {
        await window.timeping.gcalSetCalendar(id);
        state.settings.gcalCalendarId = id;
        showToast('캘린더가 설정되었습니다');
      } catch (e) {
        showToast('오류: ' + e.message, 'error');
      }
    });
  }
}

function collectSmtpSettings(container) {
  const get = id => { const el = container.querySelector(id); return el ? el.value : ''; };
  state.settings.smtp = Object.assign({}, state.settings.smtp, {
    host: get('#smtp-host'),
    port: parseInt(get('#smtp-port')) || 587,
    user: get('#smtp-user'),
    pass: get('#smtp-pass'),
    to:   get('#smtp-to'),
    preset: get('#smtp-preset'),
  });
}

// ─── Bottom Navigation ────────────────────────────────────────────────────────
function updateBottomNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;

  const items = [
    { key: 'tasks',    icon: '📋', label: '할일' },
    { key: 'schedule', icon: '📅', label: '일정' },
    { key: 'history',  icon: '🕐', label: '기록' },
    { key: 'settings', icon: '⚙️', label: '설정' },
  ];

  nav.innerHTML = items.map(item => `
    <button class="nav-item${state.tab===item.key?' active':''}" data-tab="${item.key}">
      <span class="nav-icon">${item.icon}</span>
      <span class="nav-label">${item.label}</span>
    </button>`).join('');

  nav.addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const newTab = btn.dataset.tab;
    if (newTab === state.tab) return;
    state.tab = newTab;
    state.expandedId = null;
    state.selectMode = false;
    state.selectedIds = [];
    fullRender();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Cache version BEFORE first render so the header has it
  await loadAppVersion();

  // Initial render (skeleton)
  fullRender();
  startClock();

  // Load data
  try {
    const [tasks, settings, gcalStatus, gcalConfig] = await Promise.all([
      window.timeping.getTasks(),
      window.timeping.getSettings(),
      window.timeping.gcalStatus(),
      window.timeping.gcalGetConfig(),
    ]);
    state.tasks      = tasks || [];
    state.settings   = settings || {};
    state.gcalStatus = gcalStatus;
    state.gcalConfig = gcalConfig || { client_id: '', hasSecret: false };

    // Load gcal calendars if connected
    if (gcalStatus && gcalStatus.authenticated) {
      try {
        const result = await window.timeping.gcalGetCalendars();
        state.gcalCalendars = (result && result.calendars) || [];
      } catch (e) {}
    }
  } catch (e) {
    console.error('Init error:', e);
  }

  fullRender();

  // IPC listeners
  window.timeping.onTasksUpdated(tasks => {
    state.tasks = tasks || [];
    if (['tasks', 'schedule', 'history'].includes(state.tab)) {
      updateMainContent();
    }
  });

  window.timeping.onPlaySound(() => {
    playAlertSound();
  });

  window.timeping.onToast((msg, type) => {
    showToast(msg, type);
  });

  window.addEventListener('resize', adjustLayout);

  // ─── v2.0: Remote messaging + alarm pause overlay ────────────────
  mountV2Overlay();
}

// ╔═════════════════════════════════════════════════════════════════════════╗
// ║  v2.0 Overlay UI — floating toolbar with pause toggle + 쪽지/찌르기     ║
// ║  Rendered as a fixed-position layer outside the main render() system   ║
// ║  so it doesn't interfere with the existing view rebuilding.             ║
// ╚═════════════════════════════════════════════════════════════════════════╝
function mountV2Overlay() {
  // Guard against double-mount (if init runs more than once)
  if (document.querySelector('.v2-toolbar')) return;

  // Styles (scoped to .v2-* classes to avoid collision)
  const style = document.createElement('style');
  style.textContent = `
    .v2-toolbar {
      position: fixed; top: 7px; right: 12px; z-index: 500;
      display: flex; gap: 6px; align-items: center;
      -webkit-app-region: no-drag;
      background: var(--surface);
      padding: 0;
    }
    .v2-btn-wrap { position: relative; display: inline-flex; }
    .v2-btn {
      position: relative; width: 30px; height: 30px; border: none;
      background: var(--surface2); color: var(--text-muted);
      border-radius: 9px; cursor: pointer; font-size: 14px;
      display: flex; align-items: center; justify-content: center;
      transition: all .12s; border: 1px solid var(--border);
      overflow: hidden;
      line-height: 1;
    }
    .v2-btn > * { line-height: 1; }
    .v2-btn:hover { color: var(--primary); border-color: var(--primary); }
    .v2-btn.active { color: var(--warning); border-color: var(--warning); background: var(--warning-light); }
    .v2-btn.pinned { color: var(--primary); border-color: var(--primary); background: var(--primary-light); }
    .v2-badge {
      position: absolute; top: -6px; right: -6px;
      background: var(--danger); color: white;
      border-radius: 10px; font-size: 10px; font-weight: 700;
      min-width: 16px; height: 16px; padding: 0 5px;
      display: flex; align-items: center; justify-content: center;
      line-height: 1;
      box-shadow: 0 0 0 2px var(--bg);
      pointer-events: none;
    }
    .v2-badge:empty { display: none; }

    .v2-menu {
      position: fixed; top: 42px; right: 12px; z-index: 501;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; box-shadow: var(--shadow-lg);
      min-width: 180px; padding: 4px; animation: v2fade .15s;
    }
    @keyframes v2fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .v2-menu-item {
      padding: 8px 12px; font-size: 12px; cursor: pointer;
      color: var(--text); border-radius: 6px; user-select: none;
    }
    .v2-menu-item:hover { background: var(--surface2); }
    .v2-menu-item.danger { color: var(--danger); }
    .v2-menu-divider { height: 1px; background: var(--border); margin: 4px 0; }
    .v2-menu-label {
      font-size: 10px; color: var(--text-muted); padding: 6px 12px 2px;
      font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;
    }

    .v2-dlg-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.45);
      z-index: 1000; display: flex; align-items: center; justify-content: center;
      animation: v2fade .15s;
    }
    .v2-dlg {
      background: var(--surface); border-radius: 14px;
      width: 420px; max-width: 92vw; max-height: 88vh; padding: 16px;
      display: flex; flex-direction: column; gap: 12px;
      box-shadow: var(--shadow-lg); overflow: hidden;
    }
    .v2-dlg h2 { font-size: 14px; font-weight: 700; margin: 0; color: var(--text); }
    .v2-dlg-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; min-height: 60px; }
    .v2-msg-row {
      border: 1px solid var(--border); border-radius: 8px;
      padding: 10px; display: flex; flex-direction: column; gap: 4px;
      background: var(--surface2); cursor: default;
    }
    .v2-msg-row.unread { border-left: 3px solid var(--primary); background: var(--primary-light); }
    .v2-msg-head { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--text-muted); }
    .v2-msg-title { font-size: 13px; font-weight: 600; color: var(--text); }
    .v2-msg-body { font-size: 12px; color: var(--text-muted); white-space: pre-wrap; word-break: break-word; }
    .v2-msg-row .v2-msg-actions { display: flex; gap: 6px; margin-top: 4px; }
    .v2-mini-btn {
      font-size: 11px; padding: 4px 8px; border-radius: 5px;
      border: 1px solid var(--border); background: var(--surface); cursor: pointer;
      color: var(--text-muted);
    }
    .v2-mini-btn:hover { border-color: var(--primary); color: var(--primary); }
    .v2-mini-btn.danger:hover { border-color: var(--danger); color: var(--danger); }
    .v2-mini-btn.primary {
      background: var(--primary); color: white; border-color: var(--primary);
    }
    .v2-mini-btn.primary:hover { opacity: 0.88; }

    .v2-field { display: flex; flex-direction: column; gap: 4px; }
    .v2-field label { font-size: 11px; font-weight: 600; color: var(--text-muted); }
    .v2-field input, .v2-field select, .v2-field textarea {
      padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border);
      background: var(--surface2); color: var(--text); font-size: 13px;
      font-family: inherit; outline: none;
    }
    .v2-field input:focus, .v2-field select:focus, .v2-field textarea:focus { border-color: var(--primary); }
    .v2-field textarea { resize: vertical; min-height: 80px; }
    .v2-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

    /* Recipient picker (autocomplete combobox) */
    .v2-picker-wrap { position: relative; }
    .v2-picker-selected {
      padding: 8px 10px; border-radius: 6px;
      background: var(--primary-light); color: var(--primary);
      font-size: 12px; font-weight: 600;
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
    }
    .v2-picker-selected .clear-sel {
      font-size: 10px; background: none; border: 1px solid currentColor;
      color: inherit; padding: 2px 7px; border-radius: 5px; cursor: pointer;
      opacity: 0.7;
    }
    .v2-picker-selected .clear-sel:hover { opacity: 1; }
    .v2-picker-dropdown {
      position: relative; margin-top: 4px;
      border: 1px solid var(--border); border-radius: 6px;
      background: var(--surface); max-height: 200px; overflow-y: auto;
      display: flex; flex-direction: column;
    }
    .v2-picker-dropdown[hidden] { display: none; }
    .v2-contact-row {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; cursor: pointer;
      border-bottom: 1px solid var(--border); font-size: 12px;
    }
    .v2-contact-row:last-child { border-bottom: none; }
    .v2-contact-row:hover { background: var(--surface2); }
    .v2-contact-row.editing {
      background: var(--primary-light); cursor: default;
    }
    .v2-contact-name { font-weight: 600; color: var(--text); }
    .v2-contact-email { color: var(--text-muted); font-size: 11px; flex: 1; }
    .v2-contact-row .v2-edit-btn {
      margin-left: auto; padding: 2px 6px; border-radius: 5px;
      background: none; border: 1px solid var(--border); cursor: pointer;
      font-size: 11px; color: var(--text-muted);
    }
    .v2-contact-row .v2-edit-btn:hover { border-color: var(--primary); color: var(--primary); }
    .v2-contact-row.editing input {
      flex: 1; padding: 4px 6px; border-radius: 4px;
      border: 1px solid var(--primary); font-size: 12px;
      background: var(--surface); color: var(--text); outline: none;
    }
    .v2-picker-empty {
      padding: 10px; text-align: center; color: var(--text-light);
      font-size: 12px;
    }

    .v2-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 0 -4px; padding: 0 4px; }
    .v2-tab {
      padding: 6px 10px; font-size: 12px; font-weight: 600;
      color: var(--text-muted); cursor: pointer; border: none;
      background: none; border-bottom: 2px solid transparent;
    }
    .v2-tab.active { color: var(--primary); border-bottom-color: var(--primary); }

    .v2-empty { text-align: center; color: var(--text-light); font-size: 12px; padding: 20px 0; }
    .v2-err {
      font-size: 11px; color: var(--danger); background: var(--danger-light);
      padding: 6px 10px; border-radius: 6px;
    }
  `;
  document.head.appendChild(style);

  // DOM
  const toolbar = document.createElement('div');
  toolbar.className = 'v2-toolbar';
  toolbar.innerHTML = `
    <button class="v2-btn" id="v2-aot-btn" title="항상 맨 위">📌</button>
    <button class="v2-btn" id="v2-pause-btn" title="알림 일시중지">🔔</button>
    <button class="v2-btn" id="v2-inbox-btn" title="쪽지함">📨</button>
    <button class="v2-btn" id="v2-send-btn" title="쪽지/찌르기 보내기">✏️</button>
    <button class="v2-btn" id="v2-update-btn" title="업데이트 확인">⬇️</button>
  `;
  document.body.appendChild(toolbar);

  const state2 = {
    pauseUntil: null,
    inbox:      [],
    menuOpen:   null,        // 'pause' | null
    inboxOpen:  false,
    composeOpen: false,
    composeMode: 'memo',
    contacts:   [],
    composeRecipient: null,  // selected contact { email, displayName, ... }
    editingAlias: null,      // email whose alias is being renamed inline
    aliases:    {},          // local name overrides: { email: aliasName }
    user:       null,
    lastError:  null,
  };

  // ── Pause menu ──────────────────────────────────────────────────
  function closeMenus() {
    document.querySelectorAll('.v2-menu').forEach(m => m.remove());
    state2.menuOpen = null;
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('.v2-menu') && !e.target.closest('#v2-pause-btn')) closeMenus();
  });

  async function refreshPauseUI() {
    const res = await window.timeping.getAlarmPause();
    state2.pauseUntil = res.until;
    const btn = document.getElementById('v2-pause-btn');
    if (btn) {
      btn.textContent = res.isPaused ? '🔕' : '🔔';
      btn.classList.toggle('active', res.isPaused);
      let tip = '알림 일시중지';
      if (res.isPaused) {
        if (res.until === 'forever') tip = '알림 중지 중 (무기한)';
        else {
          const m = Math.ceil((Number(res.until) - Date.now()) / 60000);
          tip = `알림 중지 중 (${m}분 후 재개)`;
        }
      }
      btn.title = tip;
    }
  }

  document.getElementById('v2-pause-btn').onclick = async () => {
    if (state2.menuOpen === 'pause') { closeMenus(); return; }
    closeMenus();
    state2.menuOpen = 'pause';

    const menu = document.createElement('div');
    menu.className = 'v2-menu';

    const res = await window.timeping.getAlarmPause();
    if (res.isPaused) {
      const label = res.until === 'forever'
        ? '무기한 중지 중'
        : `${Math.ceil((Number(res.until) - Date.now()) / 60000)}분 후 재개`;
      menu.innerHTML = `
        <div class="v2-menu-label">${label}</div>
        <div class="v2-menu-item" data-act="resume">▶ 지금 재개</div>
      `;
    } else {
      menu.innerHTML = `
        <div class="v2-menu-label">알림 일시중지</div>
        <div class="v2-menu-item" data-min="30">30분 동안</div>
        <div class="v2-menu-item" data-min="60">1시간 동안</div>
        <div class="v2-menu-item" data-min="240">4시간 동안</div>
        <div class="v2-menu-item" data-min="tomorrow">내일까지</div>
        <div class="v2-menu-divider"></div>
        <div class="v2-menu-item danger" data-act="forever">무기한 중지</div>
      `;
    }
    menu.onclick = async (e) => {
      const item = e.target.closest('[data-min],[data-act]');
      if (!item) return;
      if (item.dataset.act === 'resume') {
        await window.timeping.setAlarmPause(null);
      } else if (item.dataset.act === 'forever') {
        await window.timeping.setAlarmPause('forever');
      } else if (item.dataset.min === 'tomorrow') {
        const t = new Date(); t.setHours(24,0,0,0);
        await window.timeping.setAlarmPause(t.getTime());
      } else {
        const mins = Number(item.dataset.min);
        await window.timeping.setAlarmPause(Date.now() + mins * 60 * 1000);
      }
      closeMenus();
      refreshPauseUI();
    };
    document.body.appendChild(menu);
  };

  // Refresh pause label every minute so countdown updates visually
  setInterval(refreshPauseUI, 60 * 1000);
  refreshPauseUI();

  // ── Always-on-top toggle ────────────────────────────────────────
  async function refreshAotUI() {
    const on = await window.timeping.getAlwaysOnTop();
    const btn = document.getElementById('v2-aot-btn');
    if (btn) {
      btn.classList.toggle('pinned', on);
      btn.title = on ? '항상 맨 위 — 켜짐 (클릭하여 끄기)' : '항상 맨 위 — 꺼짐 (클릭하여 켜기)';
    }
  }
  document.getElementById('v2-aot-btn').onclick = async () => {
    const cur = await window.timeping.getAlwaysOnTop();
    await window.timeping.setAlwaysOnTop(!cur);
    refreshAotUI();
  };
  refreshAotUI();

  // ── Inbox modal ────────────────────────────────────────────────
  function renderBadge() {
    // Badge intentionally removed per user request — unread count visible
    // inside the inbox modal instead. Function kept as a safe no-op so other
    // call sites don't need conditional checks.
  }

  function openInbox() {
    state2.inboxOpen = true;
    const back = document.createElement('div');
    back.className = 'v2-dlg-backdrop';
    back.id = 'v2-inbox-dlg';
    back.innerHTML = `
      <div class="v2-dlg" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h2>📨 쪽지함</h2>
          <button class="v2-mini-btn" id="v2-inbox-close">닫기</button>
        </div>
        <div class="v2-dlg-list" id="v2-inbox-list"></div>
      </div>`;
    back.onclick = () => { back.remove(); state2.inboxOpen = false; };
    document.body.appendChild(back);
    document.getElementById('v2-inbox-close').onclick = () => { back.remove(); state2.inboxOpen = false; };
    renderInboxList();
  }

  function renderInboxList() {
    const list = document.getElementById('v2-inbox-list');
    if (!list) return;
    if (!state2.inbox.length) {
      list.innerHTML = '<div class="v2-empty">받은 쪽지가 없습니다.</div>';
      return;
    }
    const esc = s => String(s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    list.innerHTML = state2.inbox.map(m => {
      const when = m.createdAt ? new Date(m.createdAt).toLocaleString('ko-KR', { hour:'2-digit', minute:'2-digit', month:'short', day:'numeric' }) : '';
      const typeLabel = m.type === 'poke' ? '📌 일정 찌르기' : '📩 쪽지';
      // Prefer local alias > remote fromName > email
      const from = (state2.aliases && state2.aliases[m.from]) || m.fromName || m.from;
      const title = m.payload?.title || (m.type === 'memo' ? '쪽지' : '');
      const body = m.type === 'memo' ? (m.payload?.text || '') : (m.payload?.memo || '');
      const metaTags = m.type === 'poke'
        ? `<div style="font-size:11px;color:var(--text-muted);">⏰ ${esc(m.payload?.alertTime || '')} · 📅 ${esc(m.payload?.targetDate || '')}</div>`
        : '';

      let actions = '';
      // Reply is always available
      const replyBtn = `<button class="v2-mini-btn" data-msg="${m.id}" data-act="reply">💬 답장</button>`;
      if (m.type === 'poke' && m.status === 'unread') {
        const isOpt = m.payload?.optional;
        actions = isOpt
          ? `${replyBtn}
             <button class="v2-mini-btn danger" data-msg="${m.id}" data-act="decline">닫기</button>
             <button class="v2-mini-btn primary" data-msg="${m.id}" data-act="accept-add">확인 + 등록</button>`
          : `${replyBtn}
             <button class="v2-mini-btn danger" data-msg="${m.id}" data-act="decline">거절</button>
             <button class="v2-mini-btn primary" data-msg="${m.id}" data-act="accept">수락</button>`;
      } else if (m.status === 'unread') {
        actions = `${replyBtn}
                   <button class="v2-mini-btn primary" data-msg="${m.id}" data-act="read">확인</button>`;
      } else {
        const statusLabel = m.status === 'read' ? '읽음'
                          : m.status === 'accepted' ? '✓ 수락함'
                          : m.status === 'declined' ? '거절함' : '';
        actions = `<span style="font-size:11px;color:var(--text-light);margin-right:auto;">${statusLabel}</span>
                   ${replyBtn}
                   <button class="v2-mini-btn danger" data-msg="${m.id}" data-act="delete">🗑 삭제</button>`;
      }

      return `
        <div class="v2-msg-row ${m.status === 'unread' ? 'unread' : ''}">
          <div class="v2-msg-head">
            <span>${esc(typeLabel)} · ${esc(from)}</span>
            <span>${esc(when)}</span>
          </div>
          ${title ? `<div class="v2-msg-title">${esc(title)}</div>` : ''}
          ${body ? `<div class="v2-msg-body">${esc(body)}</div>` : ''}
          ${metaTags}
          <div class="v2-msg-actions">${actions}</div>
        </div>`;
    }).join('');

    list.onclick = async (e) => {
      const btn = e.target.closest('[data-msg]');
      if (!btn) return;
      const msgId = btn.dataset.msg;
      const act = btn.dataset.act;
      if (act === 'read') {
        await window.timeping.remoteMarkRead(msgId);
      } else if (act === 'accept' || act === 'accept-add') {
        await window.timeping.remoteRespondPoke(msgId, true);
        window.timeping.memoDismiss(msgId, true);   // add to my schedule
      } else if (act === 'decline') {
        await window.timeping.remoteRespondPoke(msgId, false);
      } else if (act === 'delete') {
        await window.timeping.remoteDeleteMessage(msgId);
      } else if (act === 'reply') {
        openReplyDialog(msgId);
        return;
      }
      const res = await window.timeping.remoteFetchInbox();
      state2.inbox = res.items || [];
      renderBadge();
      renderInboxList();
    };
  }

  function openReplyDialog(originalMsgId) {
    const msg = state2.inbox.find(m => m.id === originalMsgId);
    if (!msg) return;
    const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const back = document.createElement('div');
    back.className = 'v2-dlg-backdrop';
    back.innerHTML = `
      <div class="v2-dlg" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h2>💬 답장</h2>
          <button class="v2-mini-btn" id="v2-reply-close">닫기</button>
        </div>
        <div style="font-size:12px;color:var(--text-muted);padding:6px 10px;background:var(--surface2);border-radius:6px;">
          ${esc((state2.aliases && state2.aliases[msg.from]) || msg.fromName || msg.from)}에게 답장
          <div style="font-size:11px;color:var(--text-light);margin-top:2px;">원문: ${esc(msg.payload?.title || (msg.type === 'memo' ? '쪽지' : '일정'))}</div>
        </div>
        <div class="v2-field">
          <label>내용</label>
          <textarea id="v2-reply-text" maxlength="1000" placeholder="답장 내용..." style="min-height:100px;"></textarea>
        </div>
        <button class="v2-mini-btn primary" id="v2-reply-send" style="padding:10px;font-size:13px;">답장 보내기</button>
        <div id="v2-reply-err"></div>
      </div>`;
    back.onclick = () => back.remove();
    document.body.appendChild(back);
    document.getElementById('v2-reply-close').onclick = () => back.remove();
    document.getElementById('v2-reply-send').onclick = async () => {
      const text = document.getElementById('v2-reply-text').value.trim();
      if (!text) return;
      const r = await window.timeping.remoteReply(originalMsgId, text);
      if (r.ok) {
        await window.timeping.remoteMarkRead(originalMsgId);
        showToast('✅ 답장 보냈습니다', 'success');
        back.remove();
        const res = await window.timeping.remoteFetchInbox();
        state2.inbox = res.items || [];
        renderBadge();
        renderInboxList();
      } else {
        document.getElementById('v2-reply-err').innerHTML =
          `<div class="v2-err">${String(r.error).replace(/</g,'&lt;')}</div>`;
      }
    };
    setTimeout(() => document.getElementById('v2-reply-text').focus(), 50);
  }

  document.getElementById('v2-inbox-btn').onclick = async () => {
    await loadAliases();
    const res = await window.timeping.remoteFetchInbox();
    state2.inbox = res.items || [];
    renderBadge();
    openInbox();
  };

  window.timeping.onRemoteInbox(items => {
    state2.inbox = items || [];
    renderBadge();
    if (state2.inboxOpen) renderInboxList();
  });

  // ── Compose modal (쪽지 / 찌르기) ───────────────────────────────
  async function openCompose() {
    const statusRes = await window.timeping.remoteStatus();
    if (!statusRes.signedIn) {
      alert('먼저 Google 캘린더에 로그인해주세요 (설정 → 구글 캘린더).');
      return;
    }

    state2.composeOpen = true;
    state2.composeMode = 'memo';
    state2.composeRecipient = null;
    state2.editingAlias = null;
    await loadAliases();
    const res = await window.timeping.remoteListContacts();
    state2.contacts = res.contacts || [];

    const back = document.createElement('div');
    back.className = 'v2-dlg-backdrop';
    back.id = 'v2-compose-dlg';
    back.innerHTML = `
      <div class="v2-dlg" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h2>✉️ 보내기</h2>
          <button class="v2-mini-btn" id="v2-compose-close">닫기</button>
        </div>
        <div class="v2-tabs">
          <button class="v2-tab active" data-mode="memo">📩 쪽지</button>
          <button class="v2-tab" data-mode="poke">📌 일정 찌르기</button>
        </div>
        <div id="v2-compose-body"></div>
      </div>`;
    back.onclick = () => { back.remove(); state2.composeOpen = false; };
    document.body.appendChild(back);
    document.getElementById('v2-compose-close').onclick = () => { back.remove(); state2.composeOpen = false; };

    back.querySelector('.v2-tabs').onclick = (e) => {
      const tab = e.target.closest('[data-mode]');
      if (!tab) return;
      back.querySelectorAll('.v2-tab').forEach(t => t.classList.toggle('active', t === tab));
      state2.composeMode = tab.dataset.mode;
      renderComposeBody();
    };

    renderComposeBody();
  }

  // ── Alias storage (per-user local overrides for contact display names) ──
  async function loadAliases() {
    try {
      const s = await window.timeping.getSettings();
      state2.aliases = s.contactAliases || {};
    } catch { state2.aliases = {}; }
  }
  async function saveAlias(email, aliasName) {
    const s = await window.timeping.getSettings();
    s.contactAliases = s.contactAliases || {};
    if (aliasName && aliasName.trim()) s.contactAliases[email] = aliasName.trim();
    else delete s.contactAliases[email];
    await window.timeping.saveSettings(s);
    state2.aliases = s.contactAliases || {};
  }
  function displayNameFor(c) {
    if (!c) return '';
    return (state2.aliases && state2.aliases[c.email]) || c.displayName || c.email.split('@')[0];
  }

  // Recipient autocomplete picker. Populates:
  //   - state2.composeRecipient  = selected contact {email, displayName, ...}
  //   - state2.editingAlias       = email currently being renamed inline
  function wireRecipientPicker() {
    const input = document.getElementById('v2-compose-to-input');
    const dd    = document.getElementById('v2-compose-dropdown');
    const selBox = document.getElementById('v2-compose-selected');
    if (!input || !dd) return;
    const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    function filterContacts(q) {
      const query = (q || '').toLowerCase().trim();
      if (!query) return state2.contacts;
      return state2.contacts.filter(c =>
        displayNameFor(c).toLowerCase().includes(query) ||
        (c.email || '').toLowerCase().includes(query)
      );
    }

    function renderDropdown() {
      if (state2.composeRecipient) { dd.hidden = true; return; }
      const matches = filterContacts(input.value);
      if (!state2.contacts.length) {
        dd.innerHTML = '<div class="v2-picker-empty">같은 도메인에 등록된 사용자가 없습니다.</div>';
      } else if (!matches.length) {
        dd.innerHTML = '<div class="v2-picker-empty">검색 결과 없음</div>';
      } else {
        dd.innerHTML = matches.map(c => {
          const editing = state2.editingAlias === c.email;
          if (editing) {
            return `
              <div class="v2-contact-row editing" data-email="${esc(c.email)}">
                <input type="text" class="v2-alias-input" value="${esc(displayNameFor(c))}" maxlength="30">
                <span class="v2-contact-email">${esc(c.email)}</span>
                <button class="v2-mini-btn primary" data-email="${esc(c.email)}" data-act="save">저장</button>
                <button class="v2-mini-btn" data-email="${esc(c.email)}" data-act="cancel">취소</button>
              </div>`;
          }
          return `
            <div class="v2-contact-row" data-email="${esc(c.email)}">
              <span class="v2-contact-name">${esc(displayNameFor(c))}</span>
              <span class="v2-contact-email">${esc(c.email)}</span>
              <button class="v2-edit-btn" data-email="${esc(c.email)}" data-act="edit" title="이름 수정">✏️</button>
            </div>`;
        }).join('');
      }
      dd.hidden = false;
      if (state2.editingAlias) {
        const ai = dd.querySelector('.v2-alias-input');
        if (ai) { ai.focus(); ai.select(); }
      }
    }

    function renderSelected() {
      if (!state2.composeRecipient) { selBox.innerHTML = ''; selBox.style.display = 'none'; return; }
      const c = state2.composeRecipient;
      selBox.innerHTML = `
        <div class="v2-picker-selected">
          <span>✓ ${esc(displayNameFor(c))} &lt;${esc(c.email)}&gt;</span>
          <button class="clear-sel" id="v2-sel-clear">변경</button>
        </div>`;
      selBox.style.display = '';
      document.getElementById('v2-sel-clear').onclick = () => {
        state2.composeRecipient = null;
        input.value = '';
        renderSelected();
        renderDropdown();
        input.focus();
      };
    }

    input.addEventListener('input', () => {
      if (state2.composeRecipient) { state2.composeRecipient = null; renderSelected(); }
      renderDropdown();
    });
    input.addEventListener('focus', renderDropdown);

    dd.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-act="edit"]');
      if (editBtn) { e.stopPropagation(); state2.editingAlias = editBtn.dataset.email; renderDropdown(); return; }
      const saveBtn = e.target.closest('[data-act="save"]');
      if (saveBtn) {
        e.stopPropagation();
        const email = saveBtn.dataset.email;
        const aliasInput = dd.querySelector('.v2-alias-input');
        await saveAlias(email, aliasInput ? aliasInput.value : '');
        state2.editingAlias = null;
        renderDropdown();
        if (state2.composeRecipient?.email === email) renderSelected();
        return;
      }
      const cancelBtn = e.target.closest('[data-act="cancel"]');
      if (cancelBtn) { e.stopPropagation(); state2.editingAlias = null; renderDropdown(); return; }
      // Row selection
      const row = e.target.closest('.v2-contact-row:not(.editing)');
      if (row && row.dataset.email) {
        const c = state2.contacts.find(x => x.email === row.dataset.email);
        if (c) {
          state2.composeRecipient = c;
          input.value = displayNameFor(c);
          renderSelected();
          renderDropdown();
        }
      }
    });

    // Click outside collapses dropdown (only if we're not in the middle of alias edit)
    document.addEventListener('click', (e) => {
      if (state2.editingAlias) return;
      if (!e.target.closest('#v2-compose-body')) dd.hidden = true;
    });

    renderSelected();
    renderDropdown();
  }

  function renderComposeBody() {
    const body = document.getElementById('v2-compose-body');
    if (!body) return;
    const todayInput = new Date().toISOString().slice(0, 10);

    const recipientBlock = `
      <div class="v2-field v2-picker-wrap">
        <label>받는 사람</label>
        <input type="text" id="v2-compose-to-input" placeholder="이름 또는 이메일로 검색" autocomplete="off">
        <div id="v2-compose-selected"></div>
        <div class="v2-picker-dropdown" id="v2-compose-dropdown" hidden></div>
      </div>`;

    if (state2.composeMode === 'memo') {
      body.innerHTML = `
        ${recipientBlock}
        <div class="v2-field">
          <label>제목 (선택)</label>
          <input type="text" id="v2-compose-title" maxlength="80" placeholder="쪽지">
        </div>
        <div class="v2-field">
          <label>내용</label>
          <textarea id="v2-compose-text" maxlength="1000" placeholder="쪽지 내용..."></textarea>
        </div>
        <button class="v2-mini-btn primary" id="v2-compose-send" style="padding:10px;font-size:13px;">보내기</button>
        <div id="v2-compose-err"></div>
      `;
      wireRecipientPicker();
      document.getElementById('v2-compose-send').onclick = async () => {
        if (!state2.composeRecipient) return showComposeError('받는 사람을 선택하세요');
        const title = document.getElementById('v2-compose-title').value.trim();
        const text = document.getElementById('v2-compose-text').value.trim();
        if (!text) return showComposeError('내용을 입력하세요');
        const r = await window.timeping.remoteSendMemo(state2.composeRecipient.email, { title, text });
        if (r.ok) {
          showToast('✅ 쪽지 보냈습니다', 'success');
          document.getElementById('v2-compose-dlg').remove();
          state2.composeOpen = false;
          state2.composeRecipient = null;
        } else {
          showComposeError(r.error || '전송 실패');
        }
      };
    } else {
      body.innerHTML = `
        ${recipientBlock}
        <div class="v2-field">
          <label>일정 제목</label>
          <input type="text" id="v2-compose-title" maxlength="80" placeholder="예: 기획 리뷰 미팅">
        </div>
        <div class="v2-row2">
          <div class="v2-field">
            <label>날짜</label>
            <input type="date" id="v2-compose-date" value="${todayInput}">
          </div>
          <div class="v2-field">
            <label>시간</label>
            <input type="time" id="v2-compose-time" value="09:00">
          </div>
        </div>
        <div class="v2-field">
          <label>메모 (선택)</label>
          <textarea id="v2-compose-text" maxlength="500" placeholder="상세 내용..."></textarea>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;padding:4px 2px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text);cursor:pointer;">
            <input type="checkbox" id="v2-compose-self" style="accent-color:var(--primary);width:16px;height:16px;">
            <span>내 Google 캘린더에도 일정 등록</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text);cursor:pointer;">
            <input type="checkbox" id="v2-compose-optional" style="accent-color:var(--primary);width:16px;height:16px;">
            <span>동료에게 참조로만 (선택 참여)</span>
          </label>
          <div style="font-size:11px;color:var(--text-light);padding:0 24px;line-height:1.4;">
            "참조"로 보내면 동료가 자기 캘린더 등록 여부를 선택할 수 있어요.
          </div>
        </div>
        <button class="v2-mini-btn primary" id="v2-compose-send" style="padding:10px;font-size:13px;">찌르기 보내기</button>
        <div id="v2-compose-err"></div>
      `;
      wireRecipientPicker();
      document.getElementById('v2-compose-send').onclick = async () => {
        if (!state2.composeRecipient) return showComposeError('받는 사람을 선택하세요');
        const title = document.getElementById('v2-compose-title').value.trim();
        const date = document.getElementById('v2-compose-date').value;
        const time = document.getElementById('v2-compose-time').value;
        const memo = document.getElementById('v2-compose-text').value.trim();
        const addToMyCalendar = document.getElementById('v2-compose-self').checked;
        const optional = document.getElementById('v2-compose-optional').checked;
        if (!title) return showComposeError('일정 제목을 입력하세요');
        if (!date || !time) return showComposeError('날짜/시간을 입력하세요');
        const r = await window.timeping.remoteSendPoke(state2.composeRecipient.email, {
          title, targetDate: date, alertTime: time, memo,
          repeat: 'ONCE', repeatDay: null, priority: 'medium',
          addToMyCalendar, optional,
        });
        if (r.ok) {
          showToast('✅ 찌르기 보냈습니다', 'success');
          document.getElementById('v2-compose-dlg').remove();
          state2.composeOpen = false;
          state2.composeRecipient = null;
        } else {
          showComposeError(r.error || '전송 실패');
        }
      };
    }
  }

  function showComposeError(msg) {
    const box = document.getElementById('v2-compose-err');
    if (box) box.innerHTML = `<div class="v2-err">${String(msg).replace(/</g,'&lt;')}</div>`;
  }

  document.getElementById('v2-send-btn').onclick = openCompose;

  // ── Update check ────────────────────────────────────────────────
  document.getElementById('v2-update-btn').onclick = async () => {
    const btn = document.getElementById('v2-update-btn');
    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '⏳';
    try {
      const res = await window.timeping.checkForUpdate();
      if (!res.ok) { showToast('업데이트 확인 실패: ' + (res.error || ''), 'error'); return; }
      if (res.hasUpdate) {
        // Reverted to manual download (auto-install was rolled back —
        // Windows Smart App Control blocks the silent NSIS execution and
        // macOS Gatekeeper rejects unsigned ad-hoc installs once the file
        // picks up com.apple.quarantine, so the auto path produced more
        // confusion than convenience). Open the GitHub release page where
        // the user can pick the right asset and install manually.
        const back = document.createElement('div');
        back.className = 'v2-dlg-backdrop';
        back.id = 'v2-upd-dlg';
        back.innerHTML = `
          <div class="v2-dlg" onclick="event.stopPropagation()" style="width:380px;padding:0;gap:0;">
            <div style="padding:16px 16px 0 16px;flex-shrink:0;display:flex;justify-content:space-between;align-items:center;">
              <h2>⬇️ 새 버전 있음</h2>
              <button class="v2-mini-btn" id="v2-upd-close-x" style="padding:4px 10px;">✕</button>
            </div>
            <div style="padding:0 16px;flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;gap:10px;min-height:0;">
              <div style="font-size:13px;color:var(--text);">
                현재 버전: <b>${res.current}</b> &nbsp; → &nbsp; 최신 버전: <b style="color:var(--primary)">${res.latest}</b>
              </div>
              ${res.notes ? `<div style="font-size:12px;color:var(--text-muted);background:var(--surface2);padding:8px 10px;border-radius:6px;white-space:pre-wrap;line-height:1.5;">${String(res.notes).replace(/</g,'&lt;')}</div>` : ''}
              <div style="font-size:11px;color:var(--text-light);line-height:1.5;">
                다운로드 버튼을 누르면 GitHub 릴리스 페이지가 열립니다. 본인 OS에 맞는 파일을 받아 직접 설치해주세요. 할일·설정은 그대로 유지됩니다.
              </div>
            </div>
            <div style="padding:12px 16px 14px 16px;border-top:1px solid var(--border);flex-shrink:0;background:var(--surface);">
              <div style="display:flex;gap:8px;">
                <button class="v2-mini-btn" id="v2-upd-close" style="flex:1;padding:9px;">나중에</button>
                <button class="v2-mini-btn primary" id="v2-upd-download" style="flex:2;padding:9px;font-size:13px;">📥 다운로드 페이지 열기</button>
              </div>
            </div>
          </div>`;
        const closeFn = () => back.remove();
        back.onclick = closeFn;
        document.body.appendChild(back);
        document.getElementById('v2-upd-close').onclick = closeFn;
        document.getElementById('v2-upd-close-x').onclick = closeFn;
        document.getElementById('v2-upd-download').onclick = () => {
          // Use the release HTML page (not the asset URL) so the user can
          // pick the right file for their OS and read the release notes.
          const url = res.releaseUrl || res.downloadUrl;
          if (url) window.timeping.openExternal(url);
          closeFn();
        };
      } else {
        showToast(`✓ 최신 버전입니다 (${res.current})`, 'success');
      }
    } catch (e) {
      showToast('업데이트 확인 실패', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  };

  // Initial inbox fetch (once messaging is ready, items will stream in)
  setTimeout(async () => {
    try {
      const r = await window.timeping.remoteFetchInbox();
      state2.inbox = r.items || [];
      renderBadge();
    } catch {}
  }, 2000);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
