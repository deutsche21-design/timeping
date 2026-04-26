const nodemailer = require('nodemailer');

const SMTP_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false },
  naver: { host: 'smtp.naver.com', port: 587, secure: false },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
};

async function sendEmailAlert(task, smtpConfig) {
  const { preset, host, port, user, pass, to } = smtpConfig;
  const serverConfig = preset && SMTP_PRESETS[preset]
    ? { ...SMTP_PRESETS[preset], auth: { user, pass } }
    : { host, port: parseInt(port), secure: false, auth: { user, pass } };

  const transporter = nodemailer.createTransport(serverConfig);

  const priorityLabel = { HIGH: '높음', MEDIUM: '보통', LOW: '낮음' };
  const html = `
    <div style="font-family: sans-serif; max-width: 500px;">
      <h2 style="color: #6366f1;">⏰ TimePing 알림</h2>
      <table style="width:100%; border-collapse:collapse;">
        <tr><td style="padding:8px; font-weight:bold;">할 일</td><td style="padding:8px;">${escapeHtml(task.title)}</td></tr>
        <tr style="background:#f9f9f9"><td style="padding:8px; font-weight:bold;">카테고리</td><td style="padding:8px;">${escapeHtml(task.category || '')}</td></tr>
        <tr><td style="padding:8px; font-weight:bold;">우선순위</td><td style="padding:8px;">${priorityLabel[task.priority] || task.priority}</td></tr>
        <tr style="background:#f9f9f9"><td style="padding:8px; font-weight:bold;">알림 시각</td><td style="padding:8px;">${escapeHtml(task.alertTime || '')}</td></tr>
        ${task.memo ? `<tr><td style="padding:8px; font-weight:bold;">메모</td><td style="padding:8px;">${escapeHtml(task.memo)}</td></tr>` : ''}
      </table>
    </div>`;

  await transporter.sendMail({
    from: user,
    to: to || user,
    subject: `[TimePing 알림] ${task.title}`,
    html,
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function testSmtp(smtpConfig) {
  const { preset, host, port, user, pass } = smtpConfig;
  const serverConfig = preset && SMTP_PRESETS[preset]
    ? { ...SMTP_PRESETS[preset], auth: { user, pass } }
    : { host, port: parseInt(port), secure: false, auth: { user, pass } };
  const transporter = nodemailer.createTransport(serverConfig);
  return transporter.verify();
}

module.exports = { sendEmailAlert, testSmtp, SMTP_PRESETS };
