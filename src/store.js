const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(app.getPath('userData'), '');
// Uses ~/Library/Application Support/TimePing/ on macOS

const dataFile = path.join(dataDir, 'data.json');
const backupFile = path.join(dataDir, 'data.json.bak');

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function loadData() {
  ensureDir();
  if (!fs.existsSync(dataFile)) {
    const initial = { tasks: [], settings: {} };
    fs.writeFileSync(dataFile, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  } catch (e) {
    // Try backup
    if (fs.existsSync(backupFile)) {
      try { return JSON.parse(fs.readFileSync(backupFile, 'utf-8')); } catch {}
    }
    return { tasks: [], settings: {} };
  }
}

function saveData(data) {
  ensureDir();
  if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, backupFile);
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

function createBackup() {
  if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, backupFile);
}

function loadTasks() { return loadData().tasks || []; }
function saveTasks(tasks) {
  const data = loadData();
  data.tasks = tasks;
  saveData(data);
}
function loadSettings() { return loadData().settings || {}; }
function saveSettings(settings) {
  const data = loadData();
  data.settings = settings;
  saveData(data);
}

module.exports = { loadTasks, saveTasks, loadSettings, saveSettings, createBackup };
