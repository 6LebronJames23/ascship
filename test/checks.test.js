import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundleConsistency, checkGenerated, checkIpaVsProject } from '../src/versions.js';
import { checkLocale, checkListing } from '../src/listing.js';
import { probeVideo, checkPreview } from '../src/preview.js';

const fails = (checks) => checks.filter((c) => c.status === 'fail');
const warns = (checks) => checks.filter((c) => c.status === 'warn');

// ---------- versions ----------

const bundles = [
  { target: 'App', version: '1.3', build: '11' },
  { target: 'Widget', version: '1.3', build: '11' },
];

test('bundles on the same version pass; a lagging extension fails', () => {
  assert.equal(fails(checkBundleConsistency(bundles)).length, 0);
  const [f] = fails(checkBundleConsistency([...bundles, { target: 'Share', version: '1.3', build: '10' }]));
  assert.equal(f.id, 'version.nested');
  assert.match(f.message, /Share is 1\.3 \(10\) but App is 1\.3 \(11\)/);
});

test('IPA older than project.yml is one grouped failure', () => {
  const project = { App: { version: '1.4', build: '12' }, Widget: { version: '1.4', build: '12' } };
  const f = fails(checkIpaVsProject(bundles, project, 'project.yml'));
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].targets, ['App', 'Widget']);
  assert.match(f[0].message, /all 2 bundles\) is 1\.3 \(11\) but project\.yml says 1\.4 \(12\)/);
  assert.equal(fails(checkIpaVsProject(bundles, { App: { version: '1.3', build: '11' } }, 'project.yml')).length, 0);
});

test('project.yml bumped but xcodegen not re-run (build-setting style)', () => {
  const yml = { App: { version: '1.4', build: '12', versionVia: 'MARKETING_VERSION', buildVia: 'CURRENT_PROJECT_VERSION' } };
  const [f] = fails(checkGenerated(yml, { pbx: { version: ['1.3'], build: ['11'] } }));
  assert.match(f.message, /project\.yml says 1\.4 \(12\), generated project has 1\.3 \(11\)/);
  assert.equal(fails(checkGenerated(yml, { pbx: { version: ['1.4'], build: ['12'] } })).length, 0);
});

test('project.yml bumped but xcodegen not re-run (literal Info.plist style)', () => {
  const yml = { App: { version: '1.0.23', build: '42', versionVia: 'Info.plist', buildVia: 'Info.plist' } };
  const stale = { App: { CFBundleShortVersionString: '1.0.23', CFBundleVersion: '41' } };
  assert.equal(fails(checkGenerated(yml, { plists: stale })).length, 1);
  const fresh = { App: { CFBundleShortVersionString: '1.0.23', CFBundleVersion: '42' } };
  assert.equal(fails(checkGenerated(yml, { plists: fresh })).length, 0);
});

// ---------- listing ----------

test('clean listing passes', () => {
  const [s] = checkListing({ 'en-US': { name: 'Rounds: Interval Timer', keywords: 'emom,amrap,stopwatch', description: 'A timer.' } });
  assert.equal(fails(s.checks).length + warns(s.checks).length, 0);
});

test('length limits', () => {
  const [f] = fails(checkLocale('en-US', { name: 'x'.repeat(31) }));
  assert.match(f.message, /31 characters \(limit 30\)/);
  assert.equal(fails(checkLocale('en-US', { name: 'x'.repeat(30) })).length, 0);
  assert.equal(fails(checkLocale('en-US', { keywords: 'k'.repeat(101) })).length, 1);
});

test('emoji fail in whatsNew/description, warn elsewhere', () => {
  assert.equal(fails(checkLocale('en-US', { whatsNew: 'Mute all 🔇' })).length, 1);
  assert.equal(fails(checkLocale('en-US', { description: 'Fast ⚡️' })).length, 1);
  const c = checkLocale('en-US', { promotionalText: 'New 🎉' });
  assert.equal(fails(c).length, 0);
  assert.equal(warns(c)[0].id, 'listing.emoji');
  assert.equal(checkLocale('en-US', { description: 'Plain text & symbols: → ✓ ©' }).length, 0, 'arrows/checkmarks are not emoji');
});

test('keyword waste: duplicates, words from name/subtitle, spaces', () => {
  const ids = warns(checkLocale('en-US', {
    name: 'Rounds: Interval Timer', subtitle: 'HIIT & Tabata',
    keywords: 'emom, tabata,interval,EMOM',
  })).map((c) => c.id).sort();
  assert.deepEqual(ids, ['listing.keyword-dupes', 'listing.keyword-in-name', 'listing.keyword-spaces']);
});

// ---------- previews ----------

// Minimal MP4 writer: just enough box structure for probeVideo.
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (...ns) => Buffer.concat(ns.map((n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }));
const mvhd = (secs) => box('mvhd', u32(0, 0, 0, 1000, secs * 1000), Buffer.alloc(80));
const track = (handler, { secs, w = 0, h = 0, fps = 0 }) => box('trak',
  box('tkhd', Buffer.alloc(76), u32(w * 65536, h * 65536)),
  box('mdia',
    box('mdhd', u32(0, 0, 0, 600, secs * 600), Buffer.alloc(4)),
    box('hdlr', u32(0, 0), Buffer.from(handler, 'latin1'), Buffer.alloc(12)),
    box('minf', box('stbl', box('stts', u32(0, 1, Math.round(secs * fps), 600 / (fps || 1))))),
  ),
);
function mp4(tracks, secs) {
  const dir = mkdtempSync(join(tmpdir(), 'ascship-test-'));
  const file = join(dir, 'p.mp4');
  writeFileSync(file, Buffer.concat([box('ftyp', Buffer.from('isom')), box('mdat', Buffer.alloc(64)), box('moov', mvhd(secs), ...tracks)]));
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('good preview: 886x1920, 20s, 30fps, audio', () => {
  const v = mp4([track('vide', { secs: 20, w: 886, h: 1920, fps: 30 }), track('soun', { secs: 20 })], 20);
  try {
    const info = probeVideo(v.file);
    assert.equal(info.tracks.length, 2);
    assert.equal(Math.round(info.tracks[0].fps), 30);
    const c = checkPreview(info);
    assert.equal(fails(c).length + warns(c).length, 0);
  } finally { v.cleanup(); }
});

test('bad preview: no audio, too long, 60fps, native resolution', () => {
  const v = mp4([track('vide', { secs: 45, w: 1206, h: 2622, fps: 60 })], 45);
  try {
    const c = checkPreview(probeVideo(v.file));
    assert.deepEqual(fails(c).map((x) => x.id).sort(), ['preview.duration', 'preview.fps', 'preview.no-audio']);
    assert.equal(warns(c)[0].id, 'preview.size');
  } finally { v.cleanup(); }
});

test('non-video file is a clean error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascship-test-'));
  try {
    writeFileSync(join(dir, 'x.mp4'), 'hello');
    assert.throws(() => probeVideo(join(dir, 'x.mp4')), /not an MP4\/MOV/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
