const { Notification } = require('electron');
const path = require('path');
const fs = require('fs');

function sendSystemNotification(task) {
  // Electron 내장 Notification 사용 (node-notifier보다 안정적)
  if (!Notification.isSupported()) return;

  const priorityPrefix = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' };
  const prefix = priorityPrefix[task.priority] || '⏰';

  const bodyParts = [];
  if (task.alertTime) bodyParts.push(`알림: ${task.alertTime}`);
  if (task.memo) bodyParts.push(task.memo);

  const notifOptions = {
    title: `${prefix} ${task.title}`,
    body: bodyParts.join(' · ') || 'TimePing',
    silent: true, // 소리는 팝업 Web Audio로 처리
  };

  new Notification(notifOptions).show();
}

module.exports = { sendSystemNotification };
