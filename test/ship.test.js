import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planProfiles, applyPlan, teamFromIdentity } from '../src/profile.js';
import { exportOptionsPlist, buildPlan } from '../src/build.js';
import { diffListing, applyListing, toYaml } from '../src/listing-sync.js';
import { planSubmit, planCancel, applyOps } from '../src/submit.js';

// Records every call; answers POSTs with a fresh id.
function mockApi() {
  const calls = [];
  let n = 0;
  const api = {
    calls,
    post: async (path, body) => { calls.push(['POST', path, body]); return { data: { id: `new-${++n}`, attributes: { name: body.data.attributes?.name, uuid: `uuid-${n}`, profileContent: Buffer.from('p').toString('base64') } } }; },
    patch: async (path, body) => { calls.push(['PATCH', path, body]); return { data: {} }; },
    get: async () => { throw new Error('unexpected GET'); },
  };
  return api;
}

// ---------- profile ----------

const NOW = new Date('2026-09-27T00:00:00Z');
const identities = [
  { name: 'Apple Distribution: Jane Doe (TEAM123456)', serial: 'ABCD', kind: 'distribution' },
  { name: 'Apple Development: Jane Doe (DEV9999999)', serial: 'DEV1', kind: 'development' },
];
const certs = [
  { id: 'c-other', certificateType: 'DISTRIBUTION', serialNumber: '0FFFF', expirationDate: '2027-06-01' },
  { id: 'c-mine', certificateType: 'DISTRIBUTION', serialNumber: '00ABCD', expirationDate: '2027-06-01' },
];
const profile = (id, bundle, certId, exp = '2027-06-01', state = 'ACTIVE') => ({
  id, name: `P ${id}`, profileType: 'IOS_APP_STORE', profileState: state, expirationDate: exp,
  bundleId: { identifier: bundle }, certificates: [{ id: certId }], uuid: `u-${id}`, profileContent: 'cA==',
});

test('picks the certificate whose key is on this Mac (serials compared without leading zeros)', () => {
  const plan = planProfiles({ type: 'app-store', bundleIds: ['com.x'], certs, identities, bundles: [], profiles: [], devices: [], now: NOW });
  assert.equal(plan.cert.id, 'c-mine');
  assert.equal(plan.teamId, 'TEAM123456');
  assert.equal(teamFromIdentity('Apple Distribution: A B (ZZZZZZZZZZ)'), 'ZZZZZZZZZZ');
});

test('reuses a valid profile; recreates when wrong cert, expiring, or invalid; registers missing bundle ids', () => {
  const plan = planProfiles({
    type: 'app-store', now: NOW, certs, identities, devices: [],
    bundleIds: ['com.ok', 'com.othercert', 'com.expiring', 'com.invalid', 'com.new'],
    bundles: ['com.ok', 'com.othercert', 'com.expiring', 'com.invalid'].map((identifier, i) => ({ id: `b${i}`, identifier })),
    profiles: [profile('1', 'com.ok', 'c-mine'), profile('2', 'com.othercert', 'c-other'),
      profile('3', 'com.expiring', 'c-mine', '2026-10-05'), profile('4', 'com.invalid', 'c-mine', '2027-06-01', 'INVALID')],
  });
  assert.deepEqual(plan.items.map((i) => [i.bundleId, i.action, !!i.registerBundle]), [
    ['com.ok', 'reuse', false], ['com.othercert', 'create', false], ['com.expiring', 'create', false],
    ['com.invalid', 'create', false], ['com.new', 'create', true],
  ]);
});

test('no usable certificate explains why', () => {
  assert.throws(() => planProfiles({ type: 'app-store', bundleIds: ['a'], certs, identities: [], bundles: [], profiles: [], devices: [], now: NOW }), /private key in this Mac's keychain/);
  assert.throws(() => planProfiles({ type: 'app-store', bundleIds: ['a'], certs: [], identities, bundles: [], profiles: [], devices: [], now: NOW }), /has no distribution certificate/);
});

test('applying a plan registers, creates, and never deletes', async () => {
  const api = mockApi();
  const plan = planProfiles({ type: 'app-store', bundleIds: ['com.new'], certs, identities, bundles: [], profiles: [], devices: [], now: NOW });
  const mapping = await applyPlan(api, plan, { install: false });
  assert.deepEqual(api.calls.map(([m, p]) => `${m} ${p}`), ['POST /v1/bundleIds', 'POST /v1/profiles']);
  assert.equal(api.calls[1][2].data.relationships.bundleId.data.id, 'new-1', 'profile uses the newly registered bundle id');
  assert.deepEqual(mapping, { 'com.new': 'com.new app-store 2026-09-27 ascship' });
  assert.ok(!api.calls.some(([m]) => m === 'DELETE'));
});

// ---------- build ----------

test('export options use manual signing and never let Xcode bump build numbers', () => {
  const plist = exportOptionsPlist({ teamId: 'TEAM123456', profiles: { 'com.x': 'X & Co <App Store>' } });
  assert.match(plist, /<key>signingStyle<\/key><string>manual<\/string>/);
  assert.match(plist, /<key>manageAppVersionAndBuildNumber<\/key><false\/>/);
  assert.match(plist, /<key>com\.x<\/key><string>X &amp; Co &lt;App Store&gt;<\/string>/);
});

test('build refuses without recorded profiles', () => {
  assert.throws(() => buildPlan({ project: { dir: '/p', xcodeproj: '/p/A.xcodeproj', scheme: 'A' }, config: {} }), /Run `ascship profile` first/);
  const plan = buildPlan({ project: { dir: '/p', workspace: '/p/A.xcworkspace', scheme: 'A' }, config: { signing: { 'app-store': { teamId: 'T', profiles: { a: 'b' } } } } });
  assert.deepEqual(plan.archive.slice(0, 4), ['xcodebuild', 'archive', '-workspace', '/p/A.xcworkspace']);
});

// ---------- listing ----------

const remote = (over = {}) => ({
  info: { id: 'info1', locales: { 'en-US': { id: 'il1', name: 'App', subtitle: 'Old sub' } } },
  version: { id: 'ver1', versionString: '1.4', locales: { 'en-US': { id: 'vl1', description: 'Desc', keywords: 'a,b' } } },
  firstRelease: false, shown: {}, ...over,
});

test('diff sends only changed fields, to the right record', () => {
  const { ops } = diffListing({ 'en-US': { name: 'App', subtitle: 'New sub', keywords: 'a,b', whatsNew: 'Fixes' } }, remote());
  assert.deepEqual(ops.map((o) => [o.scope, o.id, o.changes]), [['info', 'il1', { subtitle: 'New sub' }], ['version', 'vl1', { whatsNew: 'Fixes' }]]);
});

test('whatsNew is dropped on a first release; new locales are created', async () => {
  const d = diffListing({ 'en-US': { whatsNew: 'x' }, 'de-DE': { description: 'Hallo' } }, remote({ firstRelease: true }));
  assert.equal(d.notes.length, 1);
  assert.deepEqual(d.ops.map((o) => [o.locale, o.create]), [['de-DE', true]]);
  const api = mockApi();
  await applyListing(api, d.ops);
  assert.equal(api.calls[0][1], '/v1/appStoreVersionLocalizations');
  assert.equal(api.calls[0][2].data.relationships.appStoreVersion.data.id, 'ver1');
});

test('pull prefers live app info and the in-progress version', () => {
  const y = toYaml({ shown: { info: { 'en-US': { name: 'N', subtitle: 'S' } }, version: { 'en-US': { keywords: 'k', whatsNew: '' } } } });
  assert.deepEqual(y, { 'en-US': { name: 'N', subtitle: 'S', keywords: 'k' } });
});

// ---------- submit ----------

const v = (versionString, appVersionState, createdDate, build, locs) => ({ id: `v-${versionString}`, versionString, appVersionState, createdDate, build, appStoreVersionLocalizations: locs });
const b = (version, pre, extra = {}) => ({ id: `b-${version}`, version, processingState: 'VALID', expired: false, usesNonExemptEncryption: false, preReleaseVersion: { version: pre }, ...extra });
const loc = (over = {}) => ({ id: 'l1', locale: 'en-US', description: 'Desc', keywords: 'k', whatsNew: 'Fixes', ...over });
const baseState = (over = {}) => ({
  appId: 'app1',
  versions: [v('1.4', 'PREPARE_FOR_SUBMISSION', '2026-09-26', null, [loc()]), v('1.3', 'READY_FOR_DISTRIBUTION', '2026-09-20', { id: 'b-11' }, [])],
  builds: [b('12', '1.4'), b('11', '1.3')],
  submissions: [], screenshots: { 'en-US': 6 }, ...over,
});

test('happy path: attach newest build, create submission, add item, submit', async () => {
  const plan = planSubmit(baseState());
  assert.ok(plan.ok);
  assert.deepEqual(plan.ops.map((o) => o.id), ['version.attach', 'submission.create', 'submission.item', 'submission.submit']);
  const api = mockApi();
  await applyOps(api, plan.ops);
  const [attach, create, item, submit] = api.calls;
  assert.equal(attach[1], '/v1/appStoreVersions/v-1.4/relationships/build');
  assert.equal(item[2].data.relationships.reviewSubmission.data.id, 'new-1', 'item points at the submission just created');
  assert.equal(submit[1], '/v1/reviewSubmissions/new-1');
  assert.deepEqual(submit[2].data.attributes, { submitted: true });
  assert.equal(create[0], 'POST');
});

test('reuses an existing draft submission instead of creating a second', () => {
  const plan = planSubmit(baseState({ submissions: [{ id: 'draft1', state: 'READY_FOR_REVIEW', items: [{ appStoreVersion: { id: 'v-1.4' } }] }] }));
  assert.deepEqual(plan.ops.map((o) => o.id), ['version.attach', 'submission.submit']);
  assert.equal(plan.ops.at(-1).path, '/v1/reviewSubmissions/draft1');
});

test('blocks on open submissions', () => {
  for (const state of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES']) {
    assert.throws(() => planSubmit(baseState({ submissions: [{ id: 's', state }] })), /--cancel/);
  }
  assert.throws(() => planSubmit(baseState({ submissions: [{ id: 's', state: 'CANCELING' }] })), /still canceling/);
});

test('export compliance must be answered explicitly', () => {
  const s = baseState({ builds: [b('12', '1.4', { usesNonExemptEncryption: null })] });
  assert.throws(() => planSubmit(s), /--no-encryption/);
  const plan = planSubmit(s, { noEncryption: true });
  assert.equal(plan.ops[0].id, 'build.encryption');
  assert.deepEqual(plan.ops[0].body.data.attributes, { usesNonExemptEncryption: false });
});

test('preflight: missing whatsNew on an update, no screenshots, emoji', () => {
  const plan = planSubmit(baseState({
    versions: [v('1.4', 'PREPARE_FOR_SUBMISSION', '2026-09-26', null, [loc({ whatsNew: '', description: 'Fast ⚡' })]), v('1.3', 'READY_FOR_DISTRIBUTION', '2026-09-20', null, [])],
    screenshots: { 'en-US': 0 },
  }));
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.checks.filter((c) => c.status === 'fail').map((c) => c.id).sort(), ['listing.emoji', 'submit.screenshots', 'submit.whats-new']);
});

test('creating a new version: ids from earlier calls flow into later ones', async () => {
  const s = baseState({ versions: [v('1.3', 'READY_FOR_DISTRIBUTION', '2026-09-20', null, [])] });
  assert.throws(() => planSubmit(s), /--app-version/);
  const plan = planSubmit(s, { appVersion: undefined, version: '1.4', release: 'manual' });
  assert.deepEqual(plan.ops.map((o) => o.id), ['version.create', 'version.attach', 'version.release', 'submission.create', 'submission.item', 'submission.submit']);
  const api = mockApi();
  await applyOps(api, plan.ops.filter((o) => !o.id.startsWith('submission.')));
  assert.equal(api.calls[1][1], '/v1/appStoreVersions/new-1/relationships/build');
  assert.deepEqual(api.calls[2][2].data, { type: 'appStoreVersions', id: 'new-1', attributes: { releaseType: 'MANUAL' } });
});

test('picks the build for this version, not just the newest', () => {
  const plan = planSubmit(baseState({ builds: [b('20', '2.0'), b('12', '1.4'), b('11', '1.3')] }));
  assert.equal(plan.build.version, '12');
  assert.throws(() => planSubmit(baseState({ builds: [b('12', '1.4', { processingState: 'PROCESSING' })] })), /wait for it to finish/);
});

test('cancel withdraws open submissions only', () => {
  const ops = planCancel({ submissions: [{ id: 'a', state: 'COMPLETE' }, { id: 'b', state: 'UNRESOLVED_ISSUES' }] });
  assert.deepEqual(ops.map((o) => [o.path, o.body.data.attributes]), [['/v1/reviewSubmissions/b', { canceled: true }]]);
  assert.throws(() => planCancel({ submissions: [] }), /no submission/);
});
