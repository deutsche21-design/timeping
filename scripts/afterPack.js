/**
 * afterPack.js — electron-builder afterPack hook (macOS only)
 *
 * Problem: electron-builder renames the four Helper bundles by default
 * (Electron Helper.app → "까먹지 말자 Helper.app", etc.). On macOS 26 (Tahoe),
 * the renamed Helpers cause the browser process to crash with SIGTRAP during
 * V8 isolate initialization. Binaries are otherwise byte-identical to the
 * originals — only the bundle directory / CFBundleExecutable differ.
 *
 * Fix: rename each Helper bundle, its executable, and patch its Info.plist
 * back to "Electron Helper*" after packaging. Nested signatures (linker-signed
 * ad-hoc from the Electron release) are preserved.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');

  if (!fs.existsSync(frameworks)) {
    console.warn(`  ⚠ afterPack: Frameworks dir not found at ${frameworks}`);
    return;
  }

  const entries = fs.readdirSync(frameworks);
  const helpers = entries.filter(n => n.endsWith('.app') && n.includes('Helper'));

  for (const helper of helpers) {
    // e.g. "까먹지 말자 Helper (GPU).app" → "Electron Helper (GPU).app"
    const restored = helper.replace(appName, 'Electron');
    if (restored === helper) continue;

    const oldDir = path.join(frameworks, helper);
    const newDir = path.join(frameworks, restored);
    fs.renameSync(oldDir, newDir);

    const oldExeName = helper.slice(0, -'.app'.length);
    const newExeName = restored.slice(0, -'.app'.length);
    const oldExe = path.join(newDir, 'Contents', 'MacOS', oldExeName);
    const newExe = path.join(newDir, 'Contents', 'MacOS', newExeName);
    if (fs.existsSync(oldExe)) fs.renameSync(oldExe, newExe);

    const plistPath = path.join(newDir, 'Contents', 'Info.plist');
    if (fs.existsSync(plistPath)) {
      execSync(`plutil -replace CFBundleExecutable -string "${newExeName}" "${plistPath}"`, { stdio: 'pipe' });
      execSync(`plutil -replace CFBundleDisplayName -string "${newExeName}" "${plistPath}"`, { stdio: 'pipe' });
      execSync(`plutil -replace CFBundleName -string "${newExeName}" "${plistPath}"`, { stdio: 'pipe' });
    }

    console.log(`  ✓ restored Helper name: ${restored}`);
  }
};
