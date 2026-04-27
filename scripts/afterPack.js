/**
 * afterPack.js — electron-builder afterPack hook (macOS only)
 *
 * Two passes:
 *
 * 1) Restore Helper bundle names. electron-builder renames the four Helpers
 *    (Electron Helper.app → "까먹지 말자 Helper.app", etc.). On macOS 26
 *    (Tahoe) the renamed Helpers cause the browser process to crash with
 *    SIGTRAP during V8 isolate initialization. We rename them back so the
 *    nested linker-signed ad-hoc signatures stay intact.
 *
 * 2) Outer ad-hoc re-sign. With identity:null electron-builder skips signing
 *    entirely. The result has linker-signed binaries inside but NO outer
 *    `_CodeSignature/CodeResources`, so Gatekeeper rejects the bundle once
 *    the user-downloaded zip carries a com.apple.quarantine xattr ("code
 *    has no resources but signature indicates they must be present").
 *    A plain `codesign --force --sign -` on the outer .app generates the
 *    missing CodeResources without touching nested framework signatures
 *    (no --deep).
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

  // ─── Outer ad-hoc re-sign ──────────────────────────────────────────────
  // No --deep: nested frameworks keep their original linker-signed signatures.
  // We just need the outer bundle to have a valid CodeResources / signature
  // so Gatekeeper accepts it once the .app picks up com.apple.quarantine.
  try {
    console.log(`  • codesign --force --sign - (outer-only)`);
    execSync(`codesign --force --sign - "${appPath}"`, { stdio: 'pipe' });
    execSync(`codesign --verify "${appPath}"`, { stdio: 'pipe' });
    console.log(`  ✓ outer bundle ad-hoc signed (CodeResources generated)`);
  } catch (e) {
    console.error(`  ⚠ outer codesign failed: ${e.message}`);
  }
};
