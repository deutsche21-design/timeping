const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');
const { loadSettings, saveSettings } = require('./store');

let tray = null;

function pauseLabel() {
  const s = loadSettings();
  const until = s.alarmsPausedUntil;
  if (!until) return null;
  if (until === 'forever') return '무기한 일시중지 중';
  const ms = Number(until) - Date.now();
  if (ms <= 0) return null;
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min}분 후 재개`;
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}시간 ${m}분 후 재개`;
}

function setPause(duration) {
  // duration: null = resume, 'forever' = indefinite, number = minutes
  const s = loadSettings();
  if (duration === null) {
    delete s.alarmsPausedUntil;
  } else if (duration === 'forever') {
    s.alarmsPausedUntil = 'forever';
  } else {
    s.alarmsPausedUntil = Date.now() + Number(duration) * 60 * 1000;
  }
  saveSettings(s);
}

function createTray(mainWindow, getTasksFn, onPauseChange) {
  const iconPath = path.join(app.getAppPath(), 'assets', 'tray-icon.png');
  let icon;

  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch (e) {
    console.error('Failed to load tray icon:', e.message);
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);

  function refreshTooltip() {
    const pl = pauseLabel();
    tray.setToolTip(pl ? `까먹지 말자 — 알림 일시중지 (${pl})` : '까먹지 말자');
  }

  function updateTray() {
    const tasks = getTasksFn();
    const todayStr = new Date().toISOString().slice(0, 10);

    // Feature 5: tray only shows tasks actually scheduled for today
    const todayTasks = tasks.filter(t => {
      if (t.isCompleted) return false;
      if (t.repeat === 'DAILY') return true;
      if (t.repeat === 'WEEKLY') {
        return t.repeatDay === new Date().getDay();
      }
      if (t.repeat === 'MONTHLY') {
        return t.repeatDay === new Date().getDate();
      }
      // ONCE
      return t.targetDate === todayStr;
    });
    const count = todayTasks.length;

    const todaySummary = todayTasks.slice(0, 5).map(t =>
      `${t.alertTime || ''} ${t.title}`
    );

    const pl = pauseLabel();
    const pauseSubmenu = pl
      ? [{ label: `⏸ ${pl}`, enabled: false },
         { label: '▶ 알림 재개', click: () => { setPause(null); onPauseChange && onPauseChange(); updateTray(); } }]
      : [
          { label: '30분 동안 중지',   click: () => { setPause(30);  onPauseChange && onPauseChange(); updateTray(); } },
          { label: '1시간 동안 중지',  click: () => { setPause(60);  onPauseChange && onPauseChange(); updateTray(); } },
          { label: '4시간 동안 중지',  click: () => { setPause(240); onPauseChange && onPauseChange(); updateTray(); } },
          { label: '내일까지 중지',    click: () => {
              const t = new Date(); t.setHours(24, 0, 0, 0);
              setPause(Math.max(1, Math.round((t.getTime() - Date.now()) / 60000)));
              onPauseChange && onPauseChange(); updateTray();
            }
          },
          { label: '무기한 중지',       click: () => { setPause('forever'); onPauseChange && onPauseChange(); updateTray(); } },
        ];

    const menuTemplate = [
      { label: `까먹지 말자 — 오늘 ${count}건`, enabled: false },
      { type: 'separator' },
      ...todaySummary.map(s => ({ label: s, enabled: false })),
      ...(todaySummary.length ? [{ type: 'separator' }] : []),
      { label: pl ? '🔕 알림 상태 — 일시중지' : '🔔 알림 상태 — 작동 중', enabled: false },
      { label: pl ? '알림 관리' : '알림 일시중지', submenu: pauseSubmenu },
      { type: 'separator' },
      {
        label: '앱 열기', click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      { label: '종료', click: () => app.quit() },
    ];

    const contextMenu = Menu.buildFromTemplate(menuTemplate);
    tray.setContextMenu(contextMenu);
    refreshTooltip();
  }

  function toggleWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  }

  tray.on('click', toggleWindow);

  if (process.platform === 'win32') {
    tray.on('double-click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }

  updateTray();
  // auto-refresh every minute so the "X분 후 재개" label ticks down
  setInterval(updateTray, 60 * 1000);

  return { tray, updateTray };
}

module.exports = { createTray };
