const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('timeping', {
  // Tasks
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  saveTask: (task) => ipcRenderer.invoke('save-task', task),
  deleteTask: (id) => ipcRenderer.invoke('delete-task', id),
  completeTask: (id) => ipcRenderer.invoke('complete-task', id),
  snoozeTask: (id, minutes) => ipcRenderer.send('snooze-task', id, minutes),
  restoreTask: (id) => ipcRenderer.invoke('restore-task', id),
  ackAlert: (id, action) => ipcRenderer.send('ack-alert', id, action),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  // Alarm pause (Feature 6)
  getAlarmPause: () => ipcRenderer.invoke('get-alarm-pause'),
  setAlarmPause: (until) => ipcRenderer.invoke('set-alarm-pause', until),

  // Always-on-top toggle
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('set-always-on-top', enabled),

  // Email
  testSmtp: (cfg) => ipcRenderer.invoke('test-smtp', cfg),

  // Google Calendar
  gcalAuthorize: () => ipcRenderer.invoke('gcal-authorize'),
  gcalStatus: () => ipcRenderer.invoke('gcal-status'),
  gcalGetCalendars: () => ipcRenderer.invoke('gcal-get-calendars'),
  gcalSetCalendar: (id) => ipcRenderer.invoke('gcal-set-calendar', id),
  gcalRevoke: () => ipcRenderer.invoke('gcal-revoke'),
  gcalSaveConfig: (id, secret) => ipcRenderer.invoke('gcal-save-config', id, secret),
  gcalGetConfig: () => ipcRenderer.invoke('gcal-get-config'),
  gcalSyncAll: () => ipcRenderer.invoke('gcal-sync-all'),

  // Remote messaging (Features 1 & 2)
  remoteStatus: () => ipcRenderer.invoke('remote-status'),
  remoteSendMemo: (to, body) => ipcRenderer.invoke('remote-send-memo', to, body),
  remoteSendPoke: (to, taskPayload) => ipcRenderer.invoke('remote-send-poke', to, taskPayload),
  remoteMarkRead: (msgId) => ipcRenderer.invoke('remote-mark-read', msgId),
  remoteRespondPoke: (msgId, accepted) => ipcRenderer.invoke('remote-respond-poke', msgId, accepted),
  remoteListContacts: () => ipcRenderer.invoke('remote-list-contacts'),
  remoteFetchInbox: () => ipcRenderer.invoke('remote-fetch-inbox'),
  remoteDeleteMessage: (msgId) => ipcRenderer.invoke('remote-delete-message', msgId),
  remoteReply: (originalMsgId, text) => ipcRenderer.invoke('remote-reply', originalMsgId, text),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  installUpdate: (downloadUrl, version) => ipcRenderer.invoke('install-update', downloadUrl, version),
  onUpdateProgress: (cb) => {
    ipcRenderer.on('update-progress', (_, p) => cb(p));
  },
  onRemoteInbox: (cb) => {
    ipcRenderer.on('remote-inbox-updated', (_, items) => cb(items));
  },

  // Memo window specific (for memo.html)
  memoDismiss: (msgId, convertToTask) => ipcRenderer.send('memo-dismiss', msgId, convertToTask),

  // Export
  exportCsv: (csvData, filename) => ipcRenderer.invoke('export-csv', csvData, filename),

  // Utility
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  platform: process.platform,

  // Popup window tells main its measured content height so it can resize
  popupResize: (height) => ipcRenderer.send('popup-resize', height),

  // Events from main
  onTasksUpdated: (cb) => {
    ipcRenderer.on('tasks-updated', (_, tasks) => cb(tasks));
  },
  onPlaySound: (cb) => {
    ipcRenderer.on('play-sound', (_, file) => cb(file));
  },
  onToast: (cb) => {
    ipcRenderer.on('show-toast', (_, msg, type) => cb(msg, type));
  },
});
