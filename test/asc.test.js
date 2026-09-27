import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { makeToken, hydrate, client } from '../src/asc.js';
import { deriveStatus } from '../src/status.js';

// ---------- JWT ----------

test('token is a valid ES256 JWT with the fields App Store Connect requires', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const token = makeToken({ keyId: 'ABC123', issuerId: 'iss-uuid', key: pem }, 1_000_000);
  const [h, p, s] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'ABC123', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual(payload, { iss: 'iss-uuid', iat: 1_000_000, exp: 1_001_200, aud: 'appstoreconnect-v1' });
  assert.ok(payload.exp - payload.iat <= 1200, 'Apple rejects tokens valid for more than 20 minutes');
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('unreadable key gives a clear error', () => {
  assert.throws(() => makeToken({ keyId: 'A', issuerId: 'B', keyPath: '/nope/AuthKey_A.p8' }), /file not found/);
  assert.throws(() => makeToken({ keyId: 'A', issuerId: 'B', key: 'not a key' }), /not a valid \.p8/);
});

test('API errors carry status and a readable message', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const creds = { keyId: 'A', issuerId: 'B', key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const fake = (status, body) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const api401 = client(creds, { fetchImpl: fake(401, { errors: [{ title: 'NOT_AUTHORIZED' }] }) });
  await assert.rejects(api401.get('/v1/apps'), (e) => e.status === 401 && /issuer id matches the key/.test(e.message));
  const api404 = client(creds, { fetchImpl: fake(404, { errors: [{ title: 'Not found', detail: 'no such app' }] }) });
  await assert.rejects(api404.get('/v1/apps/1?x=y'), /404 on \/v1\/apps\/1: Not found: no such app/);
});

test('hydrate resolves included relationships', () => {
  const res = {
    data: [{ type: 'appStoreVersions', id: 'v1', attributes: { versionString: '1.0' }, relationships: { build: { data: { type: 'builds', id: 'b1' } } } },
      { type: 'appStoreVersions', id: 'v2', attributes: { versionString: '1.1' }, relationships: { build: { data: null } } }],
    included: [{ type: 'builds', id: 'b1', attributes: { version: '7' } }],
  };
  const [a, b] = hydrate(res);
  assert.deepEqual(a.build, { id: 'b1', version: '7' });
  assert.equal(b.build, null);
});

// ---------- status ----------

const NOW = new Date('2026-09-27T12:00:00Z');
const ver = (versionString, appVersionState, createdDate, build) => ({ id: `v-${versionString}`, versionString, appVersionState, createdDate, build });
const bld = (version, processingState = 'VALID', uploadedDate = '2026-09-20T00:00:00Z') => ({ id: `b-${version}`, version, processingState, uploadedDate, expired: false });
const sub = (state, versionString, submittedDate = '2026-09-25T00:00:00Z') => ({ id: `s-${state}`, state, submittedDate, appStoreVersionForReview: { versionString } });
const run = (raw) => deriveStatus({ app: { id: '1', name: 'App', bundleId: 'com.x' }, versions: [], submissions: [], builds: [], ...raw }, { now: NOW });
const ids = (report, status) => report.sections.flatMap((s) => s.checks).filter((c) => !status || c.status === status).map((c) => c.id);

test('all shipped, nothing open: clean', () => {
  const r = run({ versions: [ver('1.3', 'READY_FOR_DISTRIBUTION', '2026-09-20', bld('11'))], submissions: [sub('COMPLETE', '1.3')], builds: [bld('11')] });
  assert.ok(r.ok);
  assert.deepEqual(ids(r, 'warn'), []);
  assert.ok(ids(r).includes('version.live'));
});

test('rejected submission still open is a failure with the cancel hint', () => {
  const r = run({
    versions: [ver('1.4', 'REJECTED', '2026-09-24', bld('12')), ver('1.3', 'READY_FOR_DISTRIBUTION', '2026-09-20', bld('11'))],
    submissions: [sub('UNRESOLVED_ISSUES', '1.4')], builds: [bld('12'), bld('11')],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(ids(r, 'fail').sort(), ['review.unresolved', 'version.rejected']);
  const c = r.sections[1].checks[0];
  assert.match(c.hint, /PATCH \/v1\/reviewSubmissions\/s-UNRESOLVED_ISSUES \{"canceled": true\}/);
});

test('unsubmitted draft submission is a warning', () => {
  const r = run({ submissions: [sub('READY_FOR_REVIEW', '1.4', undefined)] });
  assert.deepEqual(ids(r, 'warn'), ['review.draft']);
  assert.match(r.sections[1].checks[0].message, /never submitted/);
});

test('version being prepared: no build, privacy reminder', () => {
  const r = run({ versions: [ver('1.4', 'PREPARE_FOR_SUBMISSION', '2026-09-26', null), ver('1.3', 'READY_FOR_DISTRIBUTION', '2026-09-20', bld('11'))] });
  assert.ok(ids(r, 'warn').includes('version.no-build'));
  assert.ok(ids(r, 'info').includes('version.app-privacy'));
});

test('newer build than the one attached or in review', () => {
  const inReview = run({ versions: [ver('1.0', 'WAITING_FOR_REVIEW', '2026-09-26', bld('1'))], builds: [bld('2'), bld('1')] });
  assert.ok(ids(inReview, 'warn').includes('build.newer-unattached'));
  assert.match(inReview.sections[2].checks.at(-1).message, /in review for 1\.0 \(1\)/);
  const current = run({ versions: [ver('1.0', 'WAITING_FOR_REVIEW', '2026-09-26', bld('2'))], builds: [bld('2'), bld('1')] });
  assert.ok(!ids(current).includes('build.newer-unattached'));
});

test('export compliance, awaiting release, failed build', () => {
  assert.deepEqual(ids(run({ versions: [ver('2.0', 'WAITING_FOR_EXPORT_COMPLIANCE', '2026-09-26', bld('5'))] }), 'fail'), ['version.export-compliance']);
  assert.deepEqual(ids(run({ versions: [ver('2.0', 'PENDING_DEVELOPER_RELEASE', '2026-09-26', bld('5'))] }), 'warn'), ['version.awaiting-release']);
  assert.deepEqual(ids(run({ builds: [bld('5', 'INVALID')] }), 'fail'), ['build.invalid']);
});

test('old live version does not count as in progress', () => {
  const r = run({ versions: [ver('1.1', 'READY_FOR_DISTRIBUTION', '2026-08-01', bld('9')), ver('1.0', 'REPLACED_WITH_NEW_VERSION', '2026-07-01', bld('8'))] });
  assert.ok(ids(r).includes('version.none-pending'));
});
