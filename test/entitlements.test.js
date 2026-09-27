import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globMatch, isAllowed, checkExpected, checkAllowed, checkBuiltins, checkProfile, snapshot } from '../src/entitlements.js';

// Shapes taken from a real App Store export (team id anonymized).
const profile = {
  'application-identifier': 'TEAM123.com.example.app',
  'aps-environment': 'production',
  'com.apple.developer.applesignin': ['Default'],
  'com.apple.developer.associated-domains': '*',
  'com.apple.developer.team-identifier': 'TEAM123',
  'com.apple.security.application-groups': ['group.com.example.app'],
  'get-task-allow': false,
  'keychain-access-groups': ['TEAM123.*', 'com.apple.token'],
};
const app = {
  'application-identifier': 'TEAM123.com.example.app',
  'aps-environment': 'production',
  'com.apple.developer.applesignin': ['Default'],
  'com.apple.developer.associated-domains': ['applinks:example.com'],
  'com.apple.developer.team-identifier': 'TEAM123',
  'com.apple.security.application-groups': ['group.com.example.app'],
  'get-task-allow': false,
};
const expected = snapshot(app);
const fails = (checks) => checks.filter((c) => c.status === 'fail');

test('glob matching', () => {
  assert.ok(globMatch('TEAM123.*', 'TEAM123.com.example.app'));
  assert.ok(!globMatch('TEAM123.*', 'OTHER.com.example.app'));
  assert.ok(globMatch('*', 'anything'));
  assert.ok(globMatch('a.b', 'a.b'));
  assert.ok(!globMatch('a.b', 'aXb'), 'dots are literal');
  assert.ok(globMatch(true, true));
});

test('profile wildcards allow specific claims', () => {
  assert.ok(isAllowed(['applinks:example.com', 'webcredentials:example.com'], '*'));
  assert.ok(isAllowed(['TEAM123.com.example.shared'], ['TEAM123.*']));
  assert.ok(!isAllowed(['group.other'], ['group.com.example.app']));
  assert.ok(!isAllowed('production', undefined));
});

test('snapshot drops boilerplate keys', () => {
  assert.deepEqual(Object.keys(expected).sort(), [
    'aps-environment',
    'com.apple.developer.applesignin',
    'com.apple.developer.associated-domains',
    'com.apple.security.application-groups',
  ]);
});

test('a good build passes every check', () => {
  assert.equal(fails(checkExpected(app, expected, { profile })).length, 0);
  assert.equal(fails(checkAllowed(app, profile)).length, 0);
  assert.equal(fails(checkBuiltins(app, { distribution: 'app-store', teamId: 'TEAM123', bundleId: 'com.example.app' })).length, 0);
});

test('entitlement dropped from the app but still in the profile (the xcodegen wipe)', () => {
  const { 'aps-environment': _, ...broken } = app;
  const [f] = fails(checkExpected(broken, expected, { profile }));
  assert.equal(f.id, 'expected.missing');
  assert.equal(f.key, 'aps-environment');
  assert.match(f.hint, /profile allows it/);
  // The profile check alone would NOT catch this: the app claims less than it allows.
  assert.equal(fails(checkAllowed(broken, profile)).length, 0);
});

test('capability missing from both app and profile gets the App ID hint', () => {
  const { 'aps-environment': _a, ...brokenApp } = app;
  const { 'aps-environment': _p, ...brokenProfile } = profile;
  const [f] = fails(checkExpected(brokenApp, expected, { profile: brokenProfile }));
  assert.match(f.hint, /Enable the capability/);
});

test('missing array item and wrong scalar value', () => {
  const broken = { ...app, 'com.apple.security.application-groups': [], 'aps-environment': 'development' };
  const ids = fails(checkExpected(broken, expected, { profile })).map((f) => f.id).sort();
  assert.deepEqual(ids, ['expected.items', 'expected.value']);
});

test('app claims something the profile does not allow', () => {
  const broken = { ...app, 'com.apple.developer.healthkit': true };
  const [f] = fails(checkAllowed(broken, profile));
  assert.equal(f.key, 'com.apple.developer.healthkit');
  assert.match(f.hint, /regenerate the profile/);
});

test('unlisted claimed capability is a warning, not a failure', () => {
  const extra = { ...app, 'com.apple.developer.healthkit': true };
  const checks = checkExpected(extra, expected, { profile });
  assert.equal(fails(checks).length, 0);
  assert.ok(checks.some((c) => c.status === 'warn' && c.key === 'com.apple.developer.healthkit'));
});

test('builtin rules for store builds', () => {
  const ctx = { distribution: 'app-store', teamId: 'TEAM123', bundleId: 'com.example.app' };
  const ids = (a) => fails(checkBuiltins(a, ctx)).map((f) => f.id);
  assert.deepEqual(ids({ ...app, 'aps-environment': 'development' }), ['builtin.aps']);
  assert.deepEqual(ids({ ...app, 'get-task-allow': true }), ['builtin.get-task-allow']);
  assert.deepEqual(ids({ ...app, 'application-identifier': 'TEAM123.com.example.other' }), ['builtin.app-id']);
  assert.deepEqual(fails(checkBuiltins({ ...app, 'aps-environment': 'development' }, { ...ctx, distribution: 'development' })), []);
});

test('profile expiry and team mismatch', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const p = (expirationDate, teamId = 'TEAM123') => ({ name: 'P', teamId, expirationDate });
  assert.equal(checkProfile(p('2026-05-01T00:00:00Z'), { now })[0].id, 'profile.expired');
  assert.equal(checkProfile(p('2026-06-10T00:00:00Z'), { now })[0].id, 'profile.expiring');
  assert.equal(checkProfile(p('2027-06-01T00:00:00Z'), { now })[0].status, 'pass');
  assert.ok(checkProfile(p('2027-06-01T00:00:00Z', 'OTHER'), { now, mainTeamId: 'TEAM123' }).some((c) => c.id === 'profile.team'));
  assert.equal(checkProfile(null)[0].id, 'profile.missing');
});
