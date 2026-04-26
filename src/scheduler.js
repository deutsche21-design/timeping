/**
 * scheduler.js — fires onAlert(task) when a task's scheduled time arrives.
 *
 * Strategy:
 *  - Recurring tasks (DAILY/WEEKLY/MONTHLY) use node-cron expressions.
 *  - One-time (ONCE) tasks use setTimeout with the exact ms-delta to the
 *    target moment. This avoids cron-only-fields-without-year limitations
 *    and works reliably for future dates that don't match a cron pattern
 *    until next year. setTimeout has a max of ~24.8 days; tasks beyond that
 *    are re-armed via a daily check.
 *  - Globally paused (alarmsPausedUntil) suppresses every fire.
 */

const cron = require('node-cron');
const { loadSettings } = require('./store');

let jobs = [];
let onceTimers = [];
let rearmTimer = null;

function isAlarmPaused() {
  const s = loadSettings();
  if (!s.alarmsPausedUntil) return false;
  if (s.alarmsPausedUntil === 'forever') return true;
  return Date.now() < Number(s.alarmsPausedUntil);
}

function clearAll() {
  jobs.forEach(j => { try { j.stop(); } catch {} });
  jobs = [];
  onceTimers.forEach(t => clearTimeout(t));
  onceTimers = [];
  if (rearmTimer) { clearTimeout(rearmTimer); rearmTimer = null; }
}

function refreshScheduler(tasks, onAlert) {
  clearAll();

  let onceFiredSoon = 0;
  let recurringScheduled = 0;
  let onceDeferred = 0;

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.now();

  tasks.forEach(task => {
    if (task.isCompleted) return;

    // Pending snooze: independent timer that fires at task.snoozeUntil and
    // clears the flag once fired. Survives app restart.
    if (task.snoozeUntil && task.snoozeUntil > Date.now()) {
      const delta = task.snoozeUntil - Date.now();
      if (delta <= 2147483000) {
        const tid = setTimeout(() => {
          const { loadTasks, saveTasks } = require('./store');
          const ts = loadTasks();
          const i = ts.findIndex(x => x.id === task.id);
          if (i !== -1) {
            delete ts[i].snoozeUntil;
            saveTasks(ts);
          }
          if (isAlarmPaused()) return;
          onAlert(ts[i] || task);
        }, delta);
        onceTimers.push(tid);
      }
    }

    if (!task.alertTime) return;

    const parts = task.alertTime.split(':');
    if (parts.length < 2) return;
    const hour = parseInt(parts[0], 10);
    const minute = parseInt(parts[1], 10);
    if (isNaN(hour) || isNaN(minute)) return;

    if (task.repeat === 'ONCE') {
      if (!task.targetDate) return;
      // Build the target moment in LOCAL time
      const [y, mo, d] = task.targetDate.split('-').map(Number);
      const target = new Date(y, (mo || 1) - 1, d || 1, hour, minute, 0, 0);
      const ms = target.getTime() - now;
      if (ms <= 0) return;             // already passed
      if (ms > 2147483000) {
        // Beyond setTimeout max — defer; we'll re-evaluate in 24h via rearmTimer
        onceDeferred++;
        return;
      }
      const timer = setTimeout(() => {
        if (isAlarmPaused()) return;
        onAlert(task);
      }, ms);
      onceTimers.push(timer);
      onceFiredSoon++;
    } else {
      // Recurring: cron
      let cronExpr;
      if (task.repeat === 'DAILY') {
        cronExpr = `${minute} ${hour} * * *`;
      } else if (task.repeat === 'WEEKLY' && task.repeatDay != null) {
        cronExpr = `${minute} ${hour} * * ${task.repeatDay}`;
      } else if (task.repeat === 'MONTHLY' && task.repeatDay != null) {
        cronExpr = `${minute} ${hour} ${task.repeatDay} * *`;
      } else {
        return;
      }
      try {
        const job = cron.schedule(cronExpr, () => {
          if (isAlarmPaused()) return;
          onAlert(task);
        }, { timezone: tz });
        jobs.push(job);
        recurringScheduled++;
      } catch (e) {
        console.error('cron schedule failed for task', task.id, e.message);
      }
    }
  });

  // Re-arm distant ONCE tasks daily so they get scheduled when within range.
  if (onceDeferred > 0) {
    rearmTimer = setTimeout(() => {
      const { loadTasks } = require('./store');
      refreshScheduler(loadTasks(), onAlert);
    }, 24 * 60 * 60 * 1000);
  }

  console.log(`Scheduler: ${recurringScheduled} recurring, ${onceFiredSoon} one-time armed, ${onceDeferred} deferred`);
}

module.exports = { refreshScheduler, isAlarmPaused };
