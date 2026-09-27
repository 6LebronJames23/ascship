// App Store Connect API client: credentials, JWT signing, requests.
// Credentials live outside the repo (~/.config/ascship/credentials.json, mode 600)
// or in env vars for CI. ascship.yaml only ever holds the app id.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BASE = 'https://api.appstoreconnect.apple.com';

export const configDir = () => process.env.ASCSHIP_CONFIG_DIR ?? join(homedir(), '.config', 'ascship');
export const credentialsPath = () => join(configDir(), 'credentials.json');

// Where altool / xcrun look for AuthKey_<id>.p8, in the same order.
export const KEY_DIRS = () => [
  join(process.cwd(), 'private_keys'),
  join(homedir(), 'private_keys'),
  join(homedir(), '.private_keys'),
  join(homedir(), '.appstoreconnect', 'private_keys'),
];

export function findKeys() {
  const found = [];
  for (const dir of KEY_DIRS()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = /^AuthKey_([A-Z0-9]+)\.p8$/.exec(f);
      if (m) found.push({ keyId: m[1], keyPath: join(dir, f) });
    }
  }
  return found;
}

export function loadCredentials() {
  const env = process.env;
  const saved = existsSync(credentialsPath()) ? JSON.parse(readFileSync(credentialsPath(), 'utf8')) : {};
  const creds = {
    keyId: env.ASC_KEY_ID ?? saved.keyId,
    issuerId: env.ASC_ISSUER_ID ?? saved.issuerId,
    keyPath: env.ASC_KEY_PATH ?? saved.keyPath,
    key: env.ASC_PRIVATE_KEY, // PEM contents, for CI secrets
  };
  if (!creds.keyId || !creds.issuerId || !(creds.key || creds.keyPath)) {
    throw new Error('no App Store Connect credentials. Run `ascship init` (or set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH / ASC_PRIVATE_KEY).');
  }
  return creds;
}

export function saveCredentials({ keyId, issuerId, keyPath }) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsPath(), JSON.stringify({ keyId, issuerId, keyPath }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(credentialsPath(), 0o600);
  return credentialsPath();
}

export function makeToken({ keyId, issuerId, keyPath, key }, now = Math.floor(Date.now() / 1000)) {
  let privateKey;
  try {
    privateKey = createPrivateKey(key ?? readFileSync(keyPath));
  } catch (e) {
    throw new Error(`could not read the API key${keyPath ? ` at ${keyPath}` : ''}: ${e.code === 'ENOENT' ? 'file not found' : 'not a valid .p8 private key'}`);
  }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${b64({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })}`;
  const sig = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

export class AscError extends Error {
  constructor(status, body, path) {
    const first = body?.errors?.[0];
    const detail = first ? `${first.title}${first.detail ? `: ${first.detail}` : ''}` : `HTTP ${status}`;
    const hint = status === 401
      ? ' (check that the issuer id matches the key, and that the key has not been revoked)'
      : status === 403 ? ' (the key\'s role is not allowed to do this; App Manager or Admin is needed)' : '';
    super(status === 401
      ? `App Store Connect rejected the API key (401)${hint}`
      : `App Store Connect ${status} on ${path.split('?')[0]}: ${detail}${hint}`);
    this.status = status;
    this.body = body;
  }
}

export function client(creds = loadCredentials(), { fetchImpl = fetch } = {}) {
  const token = makeToken(creds);
  const request = async (method, path, body) => {
    let res;
    try {
      res = await fetchImpl(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`could not reach App Store Connect: ${e.cause?.code ?? e.message}`);
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) throw new AscError(res.status, json, path);
    return json;
  };
  return { get: (path) => request('GET', path) };
}

// Resolve `included` relationships in a JSON:API response into plain objects.
export function hydrate(res) {
  const index = new Map((res.included ?? []).map((x) => [`${x.type}:${x.id}`, x]));
  const flat = (x) => {
    const out = { id: x.id, type: x.type, ...x.attributes };
    for (const [name, rel] of Object.entries(x.relationships ?? {})) {
      const d = rel.data;
      if (d === undefined) continue;
      out[name] = Array.isArray(d)
        ? d.map((r) => { const i = index.get(`${r.type}:${r.id}`); return i ? { id: i.id, ...i.attributes } : { id: r.id }; })
        : d ? (() => { const i = index.get(`${d.type}:${d.id}`); return i ? { id: i.id, ...i.attributes } : { id: d.id }; })() : null;
    }
    return out;
  };
  return Array.isArray(res.data) ? res.data.map(flat) : flat(res.data);
}
