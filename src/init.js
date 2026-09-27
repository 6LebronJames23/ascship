// `ascship init`: find or accept an API key, verify it against App Store Connect,
// save credentials outside the repo, and record the app in ascship.yaml.
import { createInterface } from 'node:readline/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findKeys, loadCredentials, saveCredentials, client, hydrate } from './asc.js';
import { loadConfig } from './doctor.js';

const ISSUER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ask(rl, question) {
  if (!rl) return undefined;
  return (await rl.question(question)).trim() || undefined;
}

export async function runInit(opts, { log = console.log } = {}) {
  const interactive = process.stdin.isTTY && !opts.json;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    let existing = {};
    try { existing = loadCredentials(); } catch {}

    // 1. Key: --key path, --key-id lookup, existing, or the only AuthKey_*.p8 on this Mac.
    let keyPath = opts.key ? resolve(opts.key) : undefined;
    let keyId = opts.keyId;
    if (keyPath && !keyId) keyId = /AuthKey_([A-Z0-9]+)\.p8$/.exec(keyPath)?.[1];
    if (!keyPath) {
      const keys = findKeys();
      const match = keyId ? keys.find((k) => k.keyId === keyId) : undefined;
      if (match) keyPath = match.keyPath;
      else if (!keyId && existing.keyPath && existsSync(existing.keyPath)) ({ keyId, keyPath } = existing);
      else if (!keyId && keys.length === 1) ({ keyId, keyPath } = keys[0]);
      else if (!keyId && keys.length > 1 && rl) {
        log('API keys found on this Mac:');
        keys.forEach((k, i) => log(`  ${i + 1}) ${k.keyId}  ${k.keyPath}`));
        const pick = keys[Number(await ask(rl, 'Which key? [number] ')) - 1];
        if (pick) ({ keyId, keyPath } = pick);
      }
    }
    if (!keyPath && keyId) throw new Error(`AuthKey_${keyId}.p8 not found in ~/.appstoreconnect/private_keys or ~/private_keys; pass --key <path>`);
    if (!keyPath) {
      const where = findKeys().length ? `several keys found (${findKeys().map((k) => k.keyId).join(', ')}); pass --key-id` : 'no AuthKey_*.p8 found in ~/.appstoreconnect/private_keys or ~/private_keys; pass --key <path>';
      throw new Error(`${where}. Create a key in App Store Connect → Users and Access → Integrations.`);
    }
    if (!keyId) throw new Error('could not tell the key id from the file name; pass --key-id');

    // 2. Issuer id.
    let issuerId = opts.issuer ?? process.env.ASC_ISSUER_ID ?? (existing.keyId === keyId ? existing.issuerId : undefined);
    if (!issuerId) issuerId = await ask(rl, 'Issuer ID (App Store Connect → Users and Access → Integrations, above the key list): ');
    if (!issuerId) throw new Error('--issuer <id> is required (shown above the key list in App Store Connect → Integrations)');
    if (!ISSUER.test(issuerId)) throw new Error(`"${issuerId}" does not look like an issuer id (expected a UUID)`);

    // 3. Verify by listing apps, then save.
    const creds = { keyId, issuerId, keyPath };
    const apps = hydrate(await client(creds).get('/v1/apps?limit=200&fields[apps]=name,bundleId'));
    const credsFile = saveCredentials(creds);

    // 4. Pick the app.
    let app;
    const want = opts.app ?? loadConfig(opts.config).data.app?.bundleId;
    if (want) {
      app = apps.find((a) => a.id === want || a.bundleId === want || a.name.toLowerCase() === String(want).toLowerCase());
      if (!app) throw new Error(`no app matching "${want}" on this account (${apps.map((a) => a.bundleId).join(', ')})`);
    } else if (apps.length === 1) {
      app = apps[0];
    } else if (rl && apps.length) {
      log('Apps on this account:');
      apps.forEach((a, i) => log(`  ${i + 1}) ${a.name}  ${a.bundleId}`));
      app = apps[Number(await ask(rl, 'Which app is this project? [number] ')) - 1];
    }

    let configWritten = false;
    if (app) {
      const { doc } = loadConfig(opts.config);
      doc.setIn(['app'], { id: app.id, bundleId: app.bundleId, name: app.name });
      writeFileSync(opts.config, doc.toString());
      configWritten = true;
    }
    return { keyId, credentialsFile: credsFile, apps: apps.length, app: app ?? null, config: configWritten ? opts.config : null };
  } finally {
    rl?.close();
  }
}
