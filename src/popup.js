const { BrowserWindow, screen, app, ipcMain } = require('electron');
const path = require('path');
const { loadSettings, saveSettings } = require('./store');

const POPUP_WIDTH  = 380;
const POPUP_HEIGHT_MAX = 210;  // will be resized to fit content after load
const POPUP_GAP    = 12;
const MAX_POPUPS   = 5;
const MARGIN       = 16;

let activePopups = [];
let ipcRegistered = false;

// Build anchor position: saved user choice, or default to top-right of current display
function anchorPosition() {
  const saved = loadSettings().popupAnchor;
  if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
    // Verify saved position is still on an attached display; otherwise fall back
    const displays = screen.getAllDisplays();
    const onScreen = displays.some(d => {
      const b = d.workArea;
      return saved.x >= b.x - 50 && saved.x <= b.x + b.width &&
             saved.y >= b.y - 50 && saved.y <= b.y + b.height;
    });
    if (onScreen) return { x: saved.x, y: saved.y };
  }
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width, height } = display.workArea;
  return {
    x: dx + width  - POPUP_WIDTH - MARGIN,
    y: dy + MARGIN,
  };
}

function savePopupAnchor(x, y) {
  const s = loadSettings();
  s.popupAnchor = { x: Math.round(x), y: Math.round(y) };
  saveSettings(s);
}

function repositionAll() {
  const anchor = anchorPosition();
  activePopups.forEach((p, i) => {
    if (p.win && !p.win.isDestroyed()) {
      const y = anchor.y + (POPUP_HEIGHT_MAX + POPUP_GAP) * i;
      p.win.setPosition(Math.round(anchor.x), Math.round(y));
    }
  });
}

function registerIPC() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on('popup-resize', (event, height) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const safeH = Math.max(100, Math.min(500, Math.round(height) || 180));
    const [w] = win.getSize();
    win.setSize(w, safeH + 2);  // +2 for shadow / rounding safety
  });
}

function showPopup(task, onComplete, onSnooze) {
  registerIPC();

  if (activePopups.length >= MAX_POPUPS) {
    const oldest = activePopups[0];
    if (oldest?.win && !oldest.win.isDestroyed()) oldest.win.close();
  }

  const anchor = anchorPosition();
  const stackY = anchor.y + (POPUP_HEIGHT_MAX + POPUP_GAP) * activePopups.length;

  const win = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT_MAX,
    x: Math.round(anchor.x),
    y: Math.round(stackY),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(app.getAppPath(), 'preload.js'),
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');

  const taskData = encodeURIComponent(JSON.stringify(task));
  win.loadFile(path.join(app.getAppPath(), 'assets', 'popup.html'), {
    query: { task: taskData },
  });

  const entry = { win, task };
  activePopups.push(entry);

  // Persist position when user drags the popup
  let lastSavedAt = 0;
  const persistMove = () => {
    const now = Date.now();
    if (now - lastSavedAt < 200) return;   // debounce
    lastSavedAt = now;
    if (win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    // Only persist the top-most popup (index 0) position as anchor
    const idx = activePopups.findIndex(p => p.win === win);
    if (idx === 0) {
      // compensate for other stacked popups — anchor is always the top one's position
      savePopupAnchor(x, y);
      // after dragging, reposition the rest to stack under the new anchor
      for (let i = 1; i < activePopups.length; i++) {
        const p = activePopups[i];
        if (p.win && !p.win.isDestroyed()) {
          p.win.setPosition(x, y + (POPUP_HEIGHT_MAX + POPUP_GAP) * i);
        }
      }
    }
  };
  win.on('moved', persistMove);

  win.on('closed', () => {
    activePopups = activePopups.filter(p => p.win !== win);
    repositionAll();
  });

  return win;
}

module.exports = { showPopup };
