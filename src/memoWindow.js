const { BrowserWindow, screen, app } = require('electron');
const path = require('path');

const WIDTH = 400;
const MARGIN = 16;

// Map messageId → window (one overlay per unread message)
const active = new Map();

function anchorForIndex(i, height) {
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;
  // Top-right stack, offset from top
  return {
    x: x + width - WIDTH - MARGIN,
    y: y + MARGIN + i * (height + 10),
  };
}

function showMemoOverlay(message) {
  if (active.has(message.id)) return active.get(message.id);

  const initialHeight = message.type === 'poke' ? 260 : 220;
  const index = active.size;
  const { x, y } = anchorForIndex(index, initialHeight);

  const win = new BrowserWindow({
    width: WIDTH,
    height: initialHeight,
    x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: true,  // memos need input (accept/decline buttons)
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(app.getAppPath(), 'preload.js'),
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');

  const payload = encodeURIComponent(JSON.stringify(message));
  win.loadFile(path.join(app.getAppPath(), 'assets', 'memo.html'), {
    query: { m: payload },
  });

  active.set(message.id, win);

  win.on('closed', () => {
    active.delete(message.id);
    // Re-stack remaining windows
    let i = 0;
    for (const w of active.values()) {
      if (!w.isDestroyed()) {
        const [, h] = w.getSize();
        const pos = anchorForIndex(i, h);
        w.setPosition(pos.x, pos.y);
      }
      i++;
    }
  });

  return win;
}

function closeMemoOverlay(messageId) {
  const w = active.get(messageId);
  if (w && !w.isDestroyed()) w.close();
}

function closeAll() {
  for (const w of active.values()) {
    if (!w.isDestroyed()) w.close();
  }
  active.clear();
}

module.exports = { showMemoOverlay, closeMemoOverlay, closeAll };
