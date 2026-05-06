const { app, BrowserWindow, ipcMain, Menu, shell, nativeImage, dialog } = require('electron');
const fs = require('fs');

app.setName('까먹지 말자');

// Windows: set App User Model ID for proper notification support
if (process.platform === 'win32') {
  app.setAppUserModelId('ai.genesislab.kkameokji');
}
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { loadTasks, saveTasks, loadSettings, saveSettings, createBackup } = require('./src/store');
const { createTray } = require('./src/tray');
const { refreshScheduler, isAlarmPaused } = require('./src/scheduler');
const { sendSystemNotification } = require('./src/notifier');
const { showPopup } = require('./src/popup');
const { sendEmailAlert, testSmtp } = require('./src/emailer');
const gcal = require('./src/gcal');
const messaging = require('./src/messaging');
const memoWindow = require('./src/memoWindow');
const updater = require('./src/updater');

let mainWindow;
let trayRef;
let isQuitting = false;

function sendToast(msg, type = 'success', delayMs = 0) {
  const send = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('show-toast', msg, type);
    }
  };
  if (delayMs > 0) setTimeout(send, delayMs);
  else send();
}

function createWindow() {
  // alwaysOnTop: default ON (first-run) unless explicitly disabled
  const s = loadSettings();
  const aot = s.alwaysOnTop !== false;

  mainWindow = new BrowserWindow({
    width: 480,
    height: 700,
    minWidth: 400,
    minHeight: 500,
    maxWidth: 800,
    maxHeight: 1000,
    show: false,
    alwaysOnTop: aot,
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(app.getAppPath(), 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(app.getAppPath(), 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── Pending-alert tracking (Feature 1+2: persistent until acknowledged) ───
// Map<taskId, { task, lastFiredAt }>. Re-fires at the user-configured
// interval (default 3 min) until 완료/스누즈 is pressed. 0 disables re-fire.
const pendingAlerts = new Map();
const DEFAULT_RE_FIRE_INTERVAL_MIN = 3;

function reFireIntervalMs() {
  const s = loadSettings();
  const m = s.realertIntervalMin;
  // undefined → default; 0 → disabled (return Infinity so check never triggers)
  if (m === 0) return Infinity;
  if (typeof m === 'number' && m > 0) return m * 60 * 1000;
  return DEFAULT_RE_FIRE_INTERVAL_MIN * 60 * 1000;
}

function ackPendingAlert(taskId) {
  pendingAlerts.delete(taskId);
}

function fireAlertChannels(task) {
  const settings = loadSettings();
  const channels = task.alertChannels && task.alertChannels.length
    ? task.alertChannels
    : ['system', 'popup', 'sound'];   // Feature 11: default includes sound

  if (channels.includes('system')) {
    sendSystemNotification(task);
  }
  if (channels.includes('popup')) {
    showPopup(task);
  }
  if (channels.includes('email') && settings.smtp) {
    sendEmailAlert(task, settings.smtp).catch(e => console.error('Email error:', e));
  }
  if (channels.includes('sound')) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('play-sound', settings.soundFile || 'default');
    }
  }
}

function handleAlert(task) {
  if (isAlarmPaused()) return;
  fireAlertChannels(task);
  pendingAlerts.set(task.id, { task, lastFiredAt: Date.now() });
}

// Periodic re-fire scan (every 30 sec; re-fires if last fire > configured interval)
setInterval(() => {
  if (isAlarmPaused()) return;
  const interval = reFireIntervalMs();
  if (!isFinite(interval)) return;   // user turned re-fire off
  const now = Date.now();
  for (const [taskId, entry] of pendingAlerts.entries()) {
    if (now - entry.lastFiredAt >= interval) {
      const tasks = loadTasks();
      const fresh = tasks.find(t => t.id === taskId);
      if (!fresh || fresh.isCompleted) {
        pendingAlerts.delete(taskId);
        continue;
      }
      fireAlertChannels(fresh);
      entry.lastFiredAt = now;
    }
  }
}, 30 * 1000);

async function completeTask(taskId) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const task = tasks[idx];
  tasks[idx].isCompleted = true;
  tasks[idx].completedAt = new Date().toISOString();
  tasks[idx].updatedAt = new Date().toISOString();
  saveTasks(tasks);
  ackPendingAlert(taskId);
  if (trayRef) trayRef.updateTray();
  refreshScheduler(tasks, handleAlert);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tasks-updated', tasks);
  }
  // Optionally delete the gcal event on complete. The setting
  // `keepGcalOnComplete` (default false) preserves the event for record-keeping.
  const settings = loadSettings();
  if (task.gcalEventId && gcal.isAuthenticated() && !settings.keepGcalOnComplete) {
    try {
      await gcal.deleteEvent(task.gcalEventId, settings.gcalCalendarId || 'primary');
      sendToast('🗑 구글 캘린더에서 삭제됐어요');
    } catch (e) {
      console.error('GCal complete-delete error:', e.message);
      sendToast('⚠ 구글 캘린더 삭제 실패: ' + (e.message || ''), 'error');
    }
  }
}

async function restoreTask(taskId) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const task = tasks[idx];
  tasks[idx].isCompleted = false;
  delete tasks[idx].completedAt;
  tasks[idx].updatedAt = new Date().toISOString();
  saveTasks(tasks);
  if (trayRef) trayRef.updateTray();
  refreshScheduler(tasks, handleAlert);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tasks-updated', tasks);
  }
  // Recreate gcal event if it had one (and isn't a synced-import)
  if (gcal.isAuthenticated() && !task.gcalImported) {
    const settings = loadSettings();
    try {
      const eventId = await gcal.createEvent(tasks[idx], settings.gcalCalendarId || 'primary');
      tasks[idx].gcalEventId = eventId;
      saveTasks(tasks);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks-updated', tasks);
      }
    } catch (e) { console.error('GCal restore-recreate:', e.message); }
  }
}

async function importFromGcal() {
  const settings = loadSettings();
  if (!gcal.isAuthenticated()) return { added: 0 };
  const calId = settings.gcalCalendarId || 'primary';

  const events = await gcal.listEvents(calId, { daysAhead: 60 });
  const tasks = loadTasks();
  const existingGcalIds = new Set(tasks.map(t => t.gcalEventId).filter(Boolean));

  const now = new Date();
  let added = 0;

  for (const event of events) {
    if (existingGcalIds.has(event.id)) continue;
    if (!event.summary || event.status === 'cancelled') continue;

    const startStr = event.start?.dateTime || event.start?.date;
    if (!startStr) continue;

    const startDate = new Date(startStr);
    if (startDate < new Date(now.getTime() - 3600000)) continue;

    const isOwnEvent = event.description && event.description.includes('우선순위:');

    const isAllDay = !!event.start?.date && !event.start?.dateTime;
    const h = isAllDay ? '09' : String(startDate.getHours()).padStart(2, '0');
    const m = isAllDay ? '00' : String(startDate.getMinutes()).padStart(2, '0');

    let repeat = 'ONCE';
    let repeatDay = null;
    if (event.recurrence) {
      const rule = event.recurrence.find(r => r.startsWith('RRULE:')) || '';
      if (rule.includes('FREQ=DAILY'))        repeat = 'DAILY';
      else if (rule.includes('FREQ=WEEKLY'))  { repeat = 'WEEKLY';  repeatDay = startDate.getDay(); }
      else if (rule.includes('FREQ=MONTHLY')) { repeat = 'MONTHLY'; repeatDay = startDate.getDate(); }
    }

    const task = {
      id: uuidv4(),
      title: event.summary,
      memo: isOwnEvent ? '' : (event.description || ''),
      alertTime: `${h}:${m}`,
      targetDate: startDate.toISOString().split('T')[0],
      repeat, repeatDay,
      priority: 'medium',
      alertChannels: ['system'],
      gcalEventId: event.id,
      gcalImported: true,
      isCompleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    tasks.push(task);
    existingGcalIds.add(event.id);
    added++;
  }

  if (added > 0) {
    saveTasks(tasks);
    refreshScheduler(tasks, handleAlert);
    if (trayRef) trayRef.updateTray();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated', tasks);
    }
  }

  return { added };
}

function scheduleSnooze(task, minutes) {
  if (isAlarmPaused()) return;
  const fireAt = Date.now() + minutes * 60 * 1000;

  // Persist snoozeUntil on the actual task so:
  //  - The UI can show a snooze badge with the upcoming fire time
  //  - The scheduler re-arms the snooze across app restarts
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === task.id);
  if (idx === -1) return;
  tasks[idx].snoozeUntil = fireAt;
  saveTasks(tasks);
  refreshScheduler(tasks, handleAlert);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tasks-updated', tasks);
  }
}

// ── Incoming-message handler: show overlay + notify renderer ──────────────
async function handleIncomingMessages(allInbox, newArrivals) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-inbox-updated', allInbox);
  }
  // Show overlays for unread arrivals that haven't been displayed yet
  for (const msg of newArrivals) {
    if (msg.status !== 'unread') continue;
    try { memoWindow.showMemoOverlay(msg); }
    catch (e) { console.error('show overlay error:', e.message); }
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  if (process.platform === 'darwin') {
    try {
      const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.png'));
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch (e) {}
  }

  createBackup();
  createWindow();

  const { updateTray } = createTray(mainWindow, loadTasks, () => {
    // Pause state changed — nothing extra needed; scheduler checks on each fire.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('show-toast', isAlarmPaused() ? '🔕 알림 일시중지' : '🔔 알림 재개', 'info');
    }
  });
  trayRef = { updateTray };

  const tasks = loadTasks();
  refreshScheduler(tasks, handleAlert);

  setupIPC();

  // Firebase messaging init (non-blocking — runs if gcal is already authed)
  messaging.onInboxUpdate(handleIncomingMessages);
  if (gcal.isAuthenticated()) {
    setImmediate(() => { messaging.init().catch(e => console.error('messaging init:', e.message)); });
  }

  // 30-min bi-directional gcal sync
  setInterval(async () => {
    if (!gcal.isAuthenticated()) return;
    try { await gcal.processPendingSync(); } catch (e) {}
    try { await importFromGcal(); } catch (e) {}
  }, 30 * 60 * 1000);

  if (gcal.isAuthenticated()) {
    setImmediate(async () => {
      try { await gcal.processPendingSync(); } catch (e) {}
      try { await importFromGcal(); } catch (e) {}
    });
  }
});

app.on('window-all-closed', () => {
  // Stay in tray
});

app.on('before-quit', () => {
  isQuitting = true;
  try { messaging.stopPolling(); } catch {}
});

function setupIPC() {
  // ─── Tasks ───────────────────────────────────────────────────────
  ipcMain.handle('get-tasks', () => loadTasks());

  ipcMain.handle('save-task', async (_, task) => {
    const tasks = loadTasks();
    const settings = loadSettings();
    const now = new Date().toISOString();
    let savedTask;

    if (task.id) {
      const idx = tasks.findIndex(t => t.id === task.id);
      if (idx !== -1) {
        savedTask = { ...tasks[idx], ...task, updatedAt: now };
        tasks[idx] = savedTask;
        if (savedTask.gcalEventId && gcal.isAuthenticated() && !savedTask.gcalImported) {
          try {
            await gcal.updateEvent(savedTask, settings.gcalCalendarId);
          } catch (e) {
            if (e.message.includes('404')) {
              savedTask.gcalEventId = null;
              tasks[idx] = savedTask;
            } else {
              console.error('GCal update error:', e.message);
              gcal.addToPendingSync({ type: 'update', task: savedTask });
            }
          }
        }
      } else {
        savedTask = { ...task, id: uuidv4(), createdAt: now, updatedAt: now, isCompleted: false };
        tasks.push(savedTask);
        if (gcal.isAuthenticated()) {
          try {
            const eventId = await gcal.createEvent(savedTask, settings.gcalCalendarId || 'primary');
            savedTask.gcalEventId = eventId;
            tasks[tasks.length - 1] = savedTask;
          } catch (e) {
            console.error('GCal create error:', e.message);
            gcal.addToPendingSync({ type: 'create', task: savedTask });
          }
        }
      }
    } else {
      savedTask = { ...task, id: uuidv4(), createdAt: now, updatedAt: now, isCompleted: false };
      tasks.push(savedTask);
      if (gcal.isAuthenticated()) {
        try {
          const eventId = await gcal.createEvent(savedTask, settings.gcalCalendarId || 'primary');
          savedTask.gcalEventId = eventId;
          tasks[tasks.length - 1] = savedTask;
        } catch (e) {
          console.error('GCal create error:', e.message);
          gcal.addToPendingSync({ type: 'create', task: savedTask });
        }
      }
    }

    saveTasks(tasks);
    refreshScheduler(tasks, handleAlert);
    if (trayRef) trayRef.updateTray();
    return tasks;
  });

  ipcMain.handle('delete-task', async (_, taskId) => {
    const tasks = loadTasks();
    const settings = loadSettings();
    const task = tasks.find(t => t.id === taskId);
    const filtered = tasks.filter(t => t.id !== taskId);
    saveTasks(filtered);
    ackPendingAlert(taskId);
    refreshScheduler(filtered, handleAlert);
    if (trayRef) trayRef.updateTray();

    // Feature 10: always try to delete from gcal (including imported events)
    if (task?.gcalEventId && gcal.isAuthenticated()) {
      try {
        await gcal.deleteEvent(task.gcalEventId, settings.gcalCalendarId);
      } catch (e) {
        console.error('GCal delete error:', e.message);
        if (!e.message.includes('404')) {
          gcal.addToPendingSync({ type: 'delete', eventId: task.gcalEventId });
          sendToast('⚠ 구글 캘린더 삭제 실패 (나중에 재시도): ' + (e.message || ''), 'error');
        }
      }
    }
    return filtered;
  });

  ipcMain.handle('complete-task', (_, taskId) => {
    completeTask(taskId);
    return loadTasks();
  });

  ipcMain.handle('restore-task', async (_, taskId) => {
    await restoreTask(taskId);
    return loadTasks();
  });

  ipcMain.on('snooze-task', (_, taskId, minutes) => {
    ackPendingAlert(taskId);
    const task = loadTasks().find(t => t.id === taskId);
    if (task) scheduleSnooze(task, minutes || 10);
  });

  ipcMain.on('ack-alert', (_, taskId) => {
    ackPendingAlert(taskId);
  });

  // ─── Settings ────────────────────────────────────────────────────
  ipcMain.handle('get-settings', () => loadSettings());

  ipcMain.handle('save-settings', (_, settings) => {
    saveSettings(settings);
    if (settings.launchAtLogin !== undefined) {
      try { app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin }); }
      catch (e) { console.error('Login item error:', e.message); }
    }
    return settings;
  });

  // ─── Alarm pause (Feature 6) ────────────────────────────────────
  ipcMain.handle('get-alarm-pause', () => {
    const s = loadSettings();
    return { until: s.alarmsPausedUntil || null, isPaused: isAlarmPaused() };
  });

  ipcMain.handle('get-always-on-top', () => {
    const s = loadSettings();
    return s.alwaysOnTop !== false;   // default true
  });

  ipcMain.handle('set-always-on-top', (_, enabled) => {
    const s = loadSettings();
    s.alwaysOnTop = !!enabled;
    saveSettings(s);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(!!enabled);
    }
    return !!enabled;
  });

  ipcMain.handle('set-alarm-pause', (_, until) => {
    const s = loadSettings();
    if (until === null || until === undefined) {
      delete s.alarmsPausedUntil;
    } else {
      s.alarmsPausedUntil = until;  // number (epoch ms) or 'forever'
    }
    saveSettings(s);
    if (trayRef) trayRef.updateTray();
    return { until: s.alarmsPausedUntil || null, isPaused: isAlarmPaused() };
  });

  // ─── Email ───────────────────────────────────────────────────────
  ipcMain.handle('test-smtp', async (_, smtpConfig) => {
    try { await testSmtp(smtpConfig); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ─── Google Calendar ─────────────────────────────────────────────
  ipcMain.handle('gcal-authorize', async () => {
    try {
      await gcal.authorizeGoogle();
      const settings = loadSettings();
      settings.gcalEnabled = true;
      if (!settings.gcalCalendarId) settings.gcalCalendarId = 'primary';
      saveSettings(settings);

      const user = gcal.getStoredUser();
      let calendars = [];
      try { calendars = await gcal.getCalendarList(); }
      catch (e) { console.error('Get calendar list error:', e.message); }

      // Also bootstrap Firebase messaging now that we have a valid Google id_token
      setImmediate(() => { messaging.init().catch(e => console.error('messaging post-auth init:', e.message)); });

      return { ok: true, user, calendars };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('gcal-sync-all', async () => {
    if (!gcal.isAuthenticated()) return { ok: false, error: '인증되지 않았습니다' };
    const settings = loadSettings();
    const tasks = loadTasks();
    const calId = settings.gcalCalendarId || 'primary';
    let exported = 0, failed = 0;

    for (const task of tasks) {
      if (task.isCompleted) continue;
      if (task.gcalImported) continue;
      try {
        if (task.gcalEventId) {
          await gcal.updateEvent(task, calId);
          exported++;
        } else if (task.alertTime) {
          const eventId = await gcal.createEvent(task, calId);
          task.gcalEventId = eventId;
          exported++;
        }
      } catch (e) {
        if (e.message.includes('404')) {
          task.gcalEventId = null;
        } else {
          console.error('Sync export error for', task.id, e.message);
          failed++;
        }
      }
    }
    saveTasks(tasks);

    let imported = 0;
    try { const r = await importFromGcal(); imported = r.added; }
    catch (e) { console.error('Sync import error:', e.message); }

    try { await gcal.processPendingSync(); } catch (e) {}

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated', loadTasks());
    }

    return { ok: true, exported, imported, failed };
  });

  ipcMain.handle('gcal-status', () => ({
    authenticated: gcal.isAuthenticated(),
    user: gcal.getStoredUser(),
    calendarId: gcal.getSelectedCalendar(),
  }));

  ipcMain.handle('gcal-get-calendars', async () => {
    try { const list = await gcal.getCalendarList(); return { ok: true, calendars: list }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('gcal-set-calendar', (_, calId) => {
    gcal.saveSelectedCalendar(calId);
    const settings = loadSettings();
    settings.gcalCalendarId = calId;
    saveSettings(settings);
    return { ok: true };
  });

  ipcMain.handle('gcal-revoke', () => {
    gcal.revokeAuth();
    messaging.signOut();
    messaging.stopPolling();
    const settings = loadSettings();
    settings.gcalEnabled = false;
    saveSettings(settings);
    return { ok: true };
  });

  ipcMain.handle('gcal-save-config', (_, clientId, clientSecret) => {
    try { gcal.saveOAuthConfig(clientId.trim(), clientSecret.trim()); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('gcal-get-config', () => gcal.getOAuthConfig());

  ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

  // ─── Remote messaging (Features 1 & 2) ──────────────────────────
  ipcMain.handle('remote-status', () => ({
    signedIn: messaging.isSignedIn(),
    user: messaging.currentUser(),
  }));

  ipcMain.handle('remote-send-memo', async (_, to, body) => {
    try {
      const msg = await messaging.sendMessage(to, 'memo', {
        title: body.title || '쪽지',
        text:  body.text  || '',
      });
      return { ok: true, msg };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('remote-send-poke', async (_, to, taskPayload) => {
    try {
      // taskPayload may include:
      //   addToMyCalendar: true   → also create a local task + Google Calendar event for sender
      //   optional: true          → recipient sees "참조" — accept/decline doesn't gate their calendar
      const { addToMyCalendar, optional, ...payload } = taskPayload || {};
      payload.optional = !!optional;

      const msg = await messaging.sendMessage(to, 'poke', payload);

      // Sender-side: add to local schedule + gcal if requested
      if (addToMyCalendar) {
        const tasks = loadTasks();
        const newTask = {
          id: uuidv4(),
          title:     payload.title,
          memo:      payload.memo || '',
          alertTime: payload.alertTime || '09:00',
          targetDate: payload.targetDate || new Date().toISOString().slice(0, 10),
          repeat:    payload.repeat || 'ONCE',
          repeatDay: payload.repeatDay ?? null,
          priority:  payload.priority || 'medium',
          alertChannels: ['system', 'popup'],
          remoteType: 'poke-sent',
          remoteTo:   to,
          isCompleted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        if (gcal.isAuthenticated()) {
          try {
            const calId = loadSettings().gcalCalendarId || 'primary';
            newTask.gcalEventId = await gcal.createEvent(newTask, calId);
          } catch (e) {
            console.error('gcal create on poke-send:', e.message);
            gcal.addToPendingSync({ type: 'create', task: newTask });
          }
        }
        tasks.push(newTask);
        saveTasks(tasks);
        refreshScheduler(tasks, handleAlert);
        if (trayRef) trayRef.updateTray();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tasks-updated', tasks);
        }
      }

      return { ok: true, msg };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('remote-mark-read', async (_, msgId) => {
    try { await messaging.markRead(msgId); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('remote-respond-poke', async (_, msgId, accepted) => {
    try {
      await messaging.respondPoke(msgId, accepted);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('remote-list-contacts', async () => {
    try { return { ok: true, contacts: await messaging.listContactsSameDomain() }; }
    catch (e) { return { ok: false, error: e.message, contacts: [] }; }
  });

  ipcMain.handle('remote-fetch-inbox', async () => {
    try { return { ok: true, items: await messaging.fetchInbox() }; }
    catch (e) { return { ok: false, error: e.message, items: [] }; }
  });

  ipcMain.handle('remote-delete-message', async (_, msgId) => {
    try { await messaging.deleteMessage(msgId); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // Reply to a received message: creates a new 'memo' addressed to the original sender.
  ipcMain.handle('remote-reply', async (_, originalMsgId, text) => {
    try {
      const inbox = await messaging.fetchInbox().catch(() => []);
      const orig = inbox.find(m => m.id === originalMsgId);
      if (!orig) return { ok: false, error: '원본 메시지를 찾을 수 없습니다' };
      const reText = `↩ ${orig.payload?.title || ''}\n${text}`.trim();
      await messaging.sendMessage(orig.from, 'memo', { title: `답장: ${orig.payload?.title || ''}`.slice(0, 80), text });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.handle('install-update', async (_, downloadUrl, version) => {
    try {
      await updater.downloadAndInstall(downloadUrl, version, (downloaded, total) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-progress', { downloaded, total });
        }
      });
      return { ok: true };
    } catch (e) {
      console.error('install-update error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('check-for-update', async () => {
    try {
      const info = await messaging.fetchLatestVersionInfo();
      const current = app.getVersion();
      if (!info || !info.version) {
        return { ok: true, current, latest: current, hasUpdate: false };
      }
      // Semver-ish compare (split by dots, numeric)
      const cmp = (a, b) => {
        const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
        const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          if ((pa[i] || 0) > (pb[i] || 0)) return 1;
          if ((pa[i] || 0) < (pb[i] || 0)) return -1;
        }
        return 0;
      };
      const hasUpdate = cmp(info.version, current) > 0;
      return {
        ok: true,
        current,
        latest: info.version,
        downloadUrl: info.downloadUrl || null,
        notes: info.notes || null,
        hasUpdate,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ─── Memo overlay dismiss (Feature 2 button handlers) ────────────
  ipcMain.on('memo-dismiss', async (_, msgId, convertToTask) => {
    // Find the message in cache for processing
    const inbox = await messaging.fetchInbox().catch(() => []);
    const msg = inbox.find(m => m.id === msgId);

    // Mark read
    try { await messaging.markRead(msgId); } catch (e) {}

    // If user asked to add to schedule → create a local task
    if (convertToTask && msg) {
      try {
        const tasks = loadTasks();
        const now = new Date();
        const alertTime = msg.type === 'poke'
          ? (msg.payload?.alertTime || '09:00')
          : `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()+5).padStart(2,'0')}`;
        const targetDate = msg.type === 'poke'
          ? (msg.payload?.targetDate || now.toISOString().slice(0,10))
          : now.toISOString().slice(0,10);

        const newTask = {
          id: uuidv4(),
          title:     msg.type === 'poke' ? (msg.payload?.title || '찌르기 일정')
                                         : (msg.payload?.title || '쪽지'),
          memo:      msg.type === 'poke' ? (msg.payload?.memo  || '')
                                         : (msg.payload?.text  || ''),
          alertTime,
          targetDate,
          repeat:    msg.payload?.repeat || 'ONCE',
          repeatDay: msg.payload?.repeatDay ?? null,
          priority:  msg.payload?.priority  || 'medium',
          alertChannels: ['system', 'popup'],
          remoteFrom: msg.from,
          remoteType: msg.type,
          isCompleted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        tasks.push(newTask);

        // Try to push to Google Calendar too
        if (gcal.isAuthenticated()) {
          try {
            const calId = loadSettings().gcalCalendarId || 'primary';
            const eventId = await gcal.createEvent(newTask, calId);
            newTask.gcalEventId = eventId;
          } catch (e) {
            console.error('gcal create from memo failed:', e.message);
            gcal.addToPendingSync({ type: 'create', task: newTask });
          }
        }

        saveTasks(tasks);
        refreshScheduler(tasks, handleAlert);
        if (trayRef) trayRef.updateTray();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tasks-updated', tasks);
        }
        sendToast('✅ 일정에 등록했어요');
      } catch (e) { console.error('memo→task error:', e.message); }
    }
  });

  // Popup window size reporter
  ipcMain.on('popup-resize', (event, height) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const safeH = Math.max(100, Math.min(500, Math.round(height) || 180));
    const [w] = win.getSize();
    win.setSize(w, safeH + 2);
  });

  // ─── Export CSV ──────────────────────────────────────────────────
  ipcMain.handle('export-csv', async (_, csvData, defaultFilename) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '성과 기록 내보내기',
      defaultPath: defaultFilename,
      filters: [
        { name: 'CSV (Excel)', extensions: ['csv'] },
        { name: '모든 파일', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { success: false };
    try {
      fs.writeFileSync(filePath, '\uFEFF' + csvData, 'utf8');
      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}
