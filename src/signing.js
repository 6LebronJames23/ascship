// Local signing identities: which certificates this Mac can actually sign with.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sh = (cmd, args, input) => execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

// Serials are compared without leading zeros and case-insensitively; Apple and openssl disagree on both.
export const normSerial = (s) => String(s ?? '').toUpperCase().replace(/^0+/, '');

export function localIdentities() {
  let out;
  try {
    out = sh('security', ['find-identity', '-v', '-p', 'codesigning']);
  } catch {
    return [];
  }
  const ids = [];
  for (const m of out.matchAll(/\)\s+([0-9A-F]{40})\s+"([^"]+)"/g)) {
    const [, sha1, name] = m;
    let serial;
    try {
      const pem = sh('security', ['find-certificate', '-a', '-Z', '-c', name, '-p']);
      // -Z prints the SHA-1 before each PEM; pick the block for this identity.
      const block = pem.split(/SHA-1 hash: /).find((b) => b.startsWith(sha1));
      const cert = block?.slice(block.indexOf('-----BEGIN'));
      if (cert) serial = sh('openssl', ['x509', '-noout', '-serial'], cert).split('=')[1].trim();
    } catch {}
    ids.push({ sha1, name, serial: normSerial(serial), kind: /Distribution/.test(name) ? 'distribution' : 'development' });
  }
  return ids;
}

export const PROFILE_TYPES = {
  'app-store': { api: 'IOS_APP_STORE', certKind: 'distribution', certTypes: ['DISTRIBUTION', 'IOS_DISTRIBUTION'], devices: false },
  'ad-hoc': { api: 'IOS_APP_ADHOC', certKind: 'distribution', certTypes: ['DISTRIBUTION', 'IOS_DISTRIBUTION'], devices: true },
  development: { api: 'IOS_APP_DEVELOPMENT', certKind: 'development', certTypes: ['DEVELOPMENT', 'IOS_DEVELOPMENT'], devices: true },
};

// Xcode 16+ reads UserData; older Xcode and xcodebuild read MobileDevice. Install to both.
export function installProfile(uuid, base64Content) {
  const dirs = [
    join(homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
    join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles'),
  ];
  const buf = Buffer.from(base64Content, 'base64');
  return dirs.map((dir) => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${uuid}.mobileprovision`);
    writeFileSync(file, buf);
    return file;
  });
}
