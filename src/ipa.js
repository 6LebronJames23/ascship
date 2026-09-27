// Reads what actually shipped: unzips an IPA and pulls entitlements, profiles and
// bundle ids out of every signed bundle with Apple's own tools (codesign, security, plutil).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';

const run = (cmd, args, input) =>
  execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 });

const plist = (buf, keyPath, format = 'json') => {
  try {
    const args = keyPath ? ['-extract', keyPath, format, '-o', '-', '-'] : ['-convert', format, '-o', '-', '-'];
    const out = run('plutil', args, buf).toString();
    return format === 'json' ? JSON.parse(out) : out.trim();
  } catch {
    return undefined;
  }
};

export function unzipIpa(ipaPath) {
  if (!existsSync(ipaPath)) throw new Error(`no such file: ${ipaPath}`);
  const dir = mkdtempSync(join(tmpdir(), 'ascship-'));
  try {
    run('ditto', ['-x', '-k', ipaPath, dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${basename(ipaPath)} is not a valid .ipa (could not unzip it)`);
  }
  const payload = join(dir, 'Payload');
  const apps = existsSync(payload) ? readdirSync(payload).filter((f) => f.endsWith('.app')) : [];
  if (apps.length !== 1) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${basename(ipaPath)} is not an iOS app archive (expected one Payload/*.app, found ${apps.length})`);
  }
  return { dir, app: join(payload, apps[0]), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Main app first, then extensions, watch apps and app clips (and their extensions).
export function findBundles(appPath) {
  const bundles = [appPath];
  const nested = (dir, sub, ext) => {
    const p = join(dir, sub);
    return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(ext)).map((f) => join(p, f)) : [];
  };
  const walk = (dir) => {
    for (const b of [...nested(dir, 'PlugIns', '.appex'), ...nested(dir, 'Extensions', '.appex')]) bundles.push(b);
    for (const b of [...nested(dir, 'Watch', '.app'), ...nested(dir, 'AppClips', '.app')]) {
      bundles.push(b);
      walk(b);
    }
  };
  walk(appPath);
  return bundles;
}

export function readEntitlements(bundlePath) {
  let xml;
  try {
    xml = run('codesign', ['-d', '--entitlements', '-', '--xml', bundlePath]);
  } catch (e) {
    throw new Error(`codesign could not read ${basename(bundlePath)}: ${e.stderr?.toString().trim() || e.message}`);
  }
  return xml.length ? plist(xml) ?? {} : {};
}

export function verifySignature(bundlePath) {
  try {
    run('codesign', ['--verify', '--strict', bundlePath]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString().trim() || e.message };
  }
}

export function readProfile(bundlePath) {
  const file = join(bundlePath, 'embedded.mobileprovision');
  if (!existsSync(file)) return null;
  const buf = run('security', ['cms', '-D', '-i', file]);
  const raw = (k) => plist(buf, k, 'raw');
  const devices = plist(buf, 'ProvisionedDevices');
  const allDevices = raw('ProvisionsAllDevices') === 'true';
  const entitlements = plist(buf, 'Entitlements') ?? {};
  return {
    name: raw('Name'),
    teamId: raw('TeamIdentifier.0'),
    expirationDate: raw('ExpirationDate'),
    entitlements,
    distribution: allDevices
      ? 'enterprise'
      : devices
        ? entitlements['get-task-allow'] === true ? 'development' : 'ad-hoc'
        : 'app-store',
  };
}

export function readBundleId(bundlePath) {
  const info = join(bundlePath, 'Info.plist');
  try {
    return run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', info]).toString().trim();
  } catch {
    return undefined;
  }
}

export const targetName = (bundlePath) => basename(bundlePath, extname(bundlePath));
