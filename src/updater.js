/**
 * updater.js — download + auto-install update binaries
 *
 *   macOS  — extract new zip, atomically swap the running .app bundle, relaunch.
 *            Works for ad-hoc signed apps as long as the bundle ID stays the
 *            same (so OS-granted permissions like notifications persist).
 *
 *   Windows — download the NSIS one-click installer and spawn it silently;
 *             the installer is configured (`oneClick: true`, `runAfterFinish: true`)
 *             to close the running app, install, and relaunch automatically.
 *
 * Install requires write permission to the target .app bundle. On macOS, that
 * means the user installed the app to ~/Applications or anywhere user-writable;
 * /Applications also works if the user account has write rights, otherwise the
 * helper script will fail and we fall back to opening the download page.
 */

const { app } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function userUpdatesDir() {
  const dir = path.join(app.getPath('userData'), 'updates');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Follow redirects for GitHub's signed S3 URLs.
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const fetch = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const lib = u.startsWith('https') ? https : http;
      const req = lib.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return fetch(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress) onProgress(downloaded, total);
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close((err) => err ? reject(err) : resolve(destPath));
        });
        file.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });
      });
      req.on('error', reject);
    };
    fetch(url);
  });
}

async function downloadAndInstall(downloadUrl, version, onProgress) {
  if (process.platform === 'darwin') {
    return await macUpdate(downloadUrl, version, onProgress);
  } else if (process.platform === 'win32') {
    return await winUpdate(downloadUrl, version, onProgress);
  } else {
    throw new Error('지원하지 않는 운영체제입니다');
  }
}

async function macUpdate(url, version, onProgress) {
  const dir = userUpdatesDir();
  const zipPath = path.join(dir, `kkameokji-${version}.zip`);

  await downloadFile(url, zipPath, onProgress);

  // Resolve currently-running .app bundle path
  const exePath = app.getPath('exe');
  // exePath = .../X.app/Contents/MacOS/X
  const appBundlePath = path.resolve(exePath, '..', '..', '..');
  if (!appBundlePath.endsWith('.app')) {
    throw new Error('앱 번들 경로를 확인할 수 없어요: ' + appBundlePath);
  }

  // Verify we have write access to the parent dir (so swap will succeed)
  const parentDir = path.dirname(appBundlePath);
  try {
    fs.accessSync(parentDir, fs.constants.W_OK);
  } catch {
    throw new Error(`설치 위치에 쓰기 권한이 없습니다: ${parentDir}\n앱을 ~/Applications 또는 사용자 쓰기 가능 위치에 옮긴 뒤 다시 시도하세요.`);
  }

  // Write installer script
  const scriptPath = path.join(dir, `install-${version}.sh`);
  const oldPid = process.pid;
  const script = `#!/bin/bash
set -e
OLD_PID=${oldPid}
ZIP="${zipPath}"
TARGET="${appBundlePath}"

# Wait up to 30s for the old process to exit
for i in $(seq 1 60); do
  kill -0 $OLD_PID 2>/dev/null || break
  sleep 0.5
done

# Extract zip to staging
STAGE=$(mktemp -d)
/usr/bin/unzip -q "$ZIP" -d "$STAGE" || { echo "unzip failed" >&2; exit 1; }

# Locate the new .app
NEW_APP=$(/usr/bin/find "$STAGE" -maxdepth 2 -name "*.app" -type d | head -1)
[ -z "$NEW_APP" ] && { echo "no .app found in archive" >&2; exit 1; }

# Replace old bundle atomically (move-aside, swap, delete)
BACKUP="${TARGET}.old-$$"
/bin/mv "$TARGET" "$BACKUP" 2>/dev/null || true
/usr/bin/ditto "$NEW_APP" "$TARGET"
/usr/bin/xattr -cr "$TARGET"

# Cleanup
/bin/rm -rf "$BACKUP" "$STAGE" "$ZIP"

# Relaunch
/usr/bin/open "$TARGET"
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  // Detach helper, then quit ourselves
  const child = spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Give the helper a moment to start its wait loop before we exit
  setTimeout(() => app.quit(), 800);
}

async function winUpdate(url, version, onProgress) {
  const dir = userUpdatesDir();

  // Path A: .zip — extract via built-in `tar.exe` (Win10+) into the install
  //   dir directly, replacing app files. Bypasses SmartScreen because we
  //   never execute an unsigned setup.exe.
  // Path B: setup.exe / portable.exe — legacy fallback (may be blocked).
  const isZip = url.endsWith('.zip');
  const isPortable = !isZip && url.includes('portable');

  if (isZip) {
    return await winUpdateZip(url, version, dir, onProgress);
  }

  const exeName = isPortable
    ? `kkameokji-portable-${version}.exe`
    : `kkameokji-setup-${version}.exe`;
  const exePath = path.join(dir, exeName);

  await downloadFile(url, exePath, onProgress);

  if (isPortable) {
    spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(exePath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
  }
  setTimeout(() => app.quit(), 800);
}

async function winUpdateZip(url, version, dir, onProgress) {
  const zipPath = path.join(dir, `kkameokji-${version}-win.zip`);
  await downloadFile(url, zipPath, onProgress);

  // Locate install dir = parent of currently-running .exe
  const exePath = app.getPath('exe');
  const installDir = path.dirname(exePath);
  const exeName = path.basename(exePath);
  const stageDir = path.join(installDir, '.update-stage');
  const oldPid = process.pid;

  // Helper batch: wait for old process → extract → swap files → relaunch.
  const batPath = path.join(dir, `install-${version}.bat`);
  // We hard-code paths into the .bat (no command-line args) so quoting is
  // consistent and Korean-character paths survive cleanly.
  const bat = `@echo off
chcp 65001 >nul

set "OLD_PID=${oldPid}"
set "ZIP=${zipPath}"
set "TARGET=${installDir}"
set "STAGE=${stageDir}"
set "EXE=${exeName}"

REM Wait up to 30s for the old process to exit
for /L %%i in (1,1,60) do (
  tasklist /FI "PID eq %OLD_PID%" 2>nul | find /I "%OLD_PID%" >nul
  if errorlevel 1 goto extract
  timeout /T 1 /NOBREAK >nul
)

:extract
if exist "%STAGE%" rmdir /S /Q "%STAGE%"
mkdir "%STAGE%"

REM tar.exe is built into Windows 10 1803+ and can extract .zip
tar -xf "%ZIP%" -C "%STAGE%"
if errorlevel 1 (
  echo Extract failed >> "%TEMP%\\kkameokji-update.log"
  exit /b 1
)

REM Mirror staged files over the install dir
xcopy "%STAGE%\\*" "%TARGET%\\" /E /Y /Q /I
if errorlevel 1 (
  echo Copy failed >> "%TEMP%\\kkameokji-update.log"
  exit /b 1
)

REM Cleanup staging
rmdir /S /Q "%STAGE%" 2>nul
del "%ZIP%" 2>nul

REM Relaunch
start "" "%TARGET%\\%EXE%"

REM Self-delete the .bat (best-effort)
(goto) 2>nul & del "%~f0"
`;
  fs.writeFileSync(batPath, bat);

  spawn('cmd.exe', ['/C', batPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();

  setTimeout(() => app.quit(), 800);
}

module.exports = { downloadAndInstall };
