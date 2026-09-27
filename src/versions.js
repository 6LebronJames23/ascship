// Version / build number checks: the "bumped project.yml, archived without
// re-running xcodegen" trap, and App Store's rule that every bundle in the IPA
// carries the same version and build as the app.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const VAR = /^\$\(([A-Z0-9_]+)\)$/;
const check = (status, id, message, extra = {}) => ({ status, id, message, ...extra });
const fmt = (v) => `${v.version ?? '?'} (${v.build ?? '?'})`;

// ---------- reading ----------

function settingsLookup(...scopes) {
  return (name) => {
    for (const s of scopes) {
      if (!s) continue;
      if (s.base && s.base[name] !== undefined) return String(s.base[name]);
      if (s[name] !== undefined && typeof s[name] !== 'object') return String(s[name]);
    }
    return undefined;
  };
}

function readPlistKey(path, key) {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', path], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

// Locate project.yml and/or the matching .xcodeproj from a path or directory.
export function findProject(arg = '.') {
  let dir = arg, yml;
  if (existsSync(arg) && statSync(arg).isFile()) {
    if (/\.ya?ml$/.test(arg)) { yml = arg; dir = dirname(arg); }
    else dir = dirname(arg);
  } else if (arg.endsWith('.xcodeproj')) {
    return { dir: dirname(arg), xcodeproj: arg };
  }
  if (!yml && existsSync(join(dir, 'project.yml'))) yml = join(dir, 'project.yml');
  const projs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.xcodeproj')) : [];
  let name;
  if (yml) name = YAML.parse(readFileSync(yml, 'utf8'))?.name;
  const pick = projs.find((p) => p === `${name}.xcodeproj`) ?? (projs.length === 1 ? projs[0] : undefined);
  if (!yml && !pick) return null;
  return { dir, yml, xcodeproj: pick ? join(dir, pick) : undefined };
}

// Versions declared in project.yml, per target, as xcodegen would resolve them.
export function readYmlVersions(ymlPath) {
  const spec = YAML.parse(readFileSync(ymlPath, 'utf8')) ?? {};
  const root = dirname(ymlPath);
  const out = {};
  for (const [name, t] of Object.entries(spec.targets ?? {})) {
    if (!/^(application|app-extension|watchkit2-extension|application\.watchapp2|extensionkit-extension)/.test(t.type ?? '')) continue;
    const lookup = settingsLookup(t.settings, spec.settings);
    const props = t.info?.properties ?? {};
    const resolve = (raw, fallbackVar) => {
      if (raw === undefined) return { value: lookup(fallbackVar), via: fallbackVar };
      const m = VAR.exec(String(raw));
      return m ? { value: lookup(m[1]), via: m[1] } : { value: String(raw), via: 'Info.plist' };
    };
    const v = resolve(props.CFBundleShortVersionString, 'MARKETING_VERSION');
    const b = resolve(props.CFBundleVersion, 'CURRENT_PROJECT_VERSION');
    out[name] = {
      type: t.type, version: v.value, build: b.value, versionVia: v.via, buildVia: b.via,
      infoPath: t.info?.path ? join(root, t.info.path) : undefined,
    };
  }
  return out;
}

// All MARKETING_VERSION / CURRENT_PROJECT_VERSION values in a generated .xcodeproj.
export function readPbxVersions(xcodeprojPath) {
  const pbx = readFileSync(join(xcodeprojPath, 'project.pbxproj'), 'utf8');
  const all = (key) => [...new Set([...pbx.matchAll(new RegExp(`\\b${key} = "?([^";]+)"?;`, 'g'))].map((m) => m[1]))];
  return { version: all('MARKETING_VERSION'), build: all('CURRENT_PROJECT_VERSION') };
}

// ---------- checks (pure) ----------

// Every bundle must match the app's version and build (ITMS-90473 otherwise).
export function checkBundleConsistency(bundles) {
  const [main, ...rest] = bundles;
  const out = [];
  for (const b of rest) {
    if (b.version !== main.version || b.build !== main.build) {
      out.push(check('fail', 'version.nested', `${b.target} is ${fmt(b)} but ${main.target} is ${fmt(main)}`, {
        hint: 'App Store Connect rejects uploads whose extensions are on a different version or build than the app.',
      }));
    }
  }
  if (!out.length) out.push(check('pass', 'version.consistent', bundles.length === 1 ? `bundle is ${fmt(main)}` : `all ${bundles.length} bundles are ${fmt(main)}`));
  return out;
}

// project.yml vs what was last generated (Info.plist files / .xcodeproj).
export function checkGenerated(yml, { plists = {}, pbx } = {}) {
  const out = [];
  const groups = new Map();
  for (const [name, t] of Object.entries(yml)) {
    const generated = {};
    for (const [field, key, via] of [['version', 'CFBundleShortVersionString', t.versionVia], ['build', 'CFBundleVersion', t.buildVia]]) {
      const want = t[field];
      if (want === undefined) continue;
      if (via === 'Info.plist') generated[field] = plists[name]?.[key] ?? want;
      else generated[field] = (pbx?.[field] ?? []).find((x) => x !== want) ?? want;
    }
    const want = { version: t.version, build: t.build };
    const have = { version: generated.version ?? t.version, build: generated.build ?? t.build };
    if (have.version !== want.version || have.build !== want.build) {
      const key = `${fmt(want)}|${fmt(have)}`;
      if (!groups.has(key)) groups.set(key, { want: fmt(want), have: fmt(have), targets: [] });
      groups.get(key).targets.push(name);
    }
  }
  for (const g of groups.values()) {
    out.push(check('fail', 'version.stale-project', `project.yml says ${g.want}, generated project has ${g.have} (${g.targets.join(', ')})`, {
      targets: g.targets,
      hint: 'Re-run xcodegen after bumping the version, then archive again.',
    }));
  }
  if (!out.length) out.push(check('pass', 'version.generated', 'generated project matches project.yml'));
  return out;
}

// The archive vs the project it was supposed to come from.
export function checkIpaVsProject(bundles, project, source) {
  const out = [];
  const groups = new Map(); // one line per distinct (IPA, project) pair, not per bundle
  for (const b of bundles) {
    const want = project[b.target];
    if (!want) continue;
    if ((want.version && want.version !== b.version) || (want.build && want.build !== b.build)) {
      const key = `${fmt(b)}|${fmt(want)}`;
      if (!groups.has(key)) groups.set(key, { have: fmt(b), want: fmt(want), targets: [] });
      groups.get(key).targets.push(b.target);
    }
  }
  for (const g of groups.values()) {
    const who = g.targets.length === bundles.length && bundles.length > 1 ? `the IPA (all ${g.targets.length} bundles)` : g.targets.join(', ') + ' in the IPA';
    out.push(check('fail', 'version.ipa-stale', `${who} is ${g.have} but ${source} says ${g.want}`, {
      targets: g.targets,
      hint: 'This archive was built before the version bump (or without regenerating the project). Archive and export again.',
    }));
  }
  if (!out.length && bundles.some((b) => project[b.target])) out.push(check('pass', 'version.ipa-matches', `IPA matches ${source}`));
  return out;
}

// ---------- orchestration ----------

export function projectVersionChecks(projectArg, ipaBundles) {
  const found = findProject(projectArg);
  if (!found) return null;
  const checks = [];
  let declared, source;
  if (found.yml) {
    declared = readYmlVersions(found.yml);
    source = basename(found.yml);
    const plists = {};
    for (const [name, t] of Object.entries(declared)) {
      if (t.infoPath && existsSync(t.infoPath)) {
        plists[name] = {
          CFBundleShortVersionString: readPlistKey(t.infoPath, 'CFBundleShortVersionString'),
          CFBundleVersion: readPlistKey(t.infoPath, 'CFBundleVersion'),
        };
      }
    }
    checks.push(...checkGenerated(declared, { plists, pbx: found.xcodeproj ? readPbxVersions(found.xcodeproj) : undefined }));
  } else {
    const pbx = readPbxVersions(found.xcodeproj);
    source = basename(found.xcodeproj);
    if (pbx.version.length > 1 || pbx.build.length > 1) {
      checks.push(check('warn', 'version.mixed', `${source} has several versions (${pbx.version.join(', ')}) / builds (${pbx.build.join(', ')})`));
    }
    const main = ipaBundles?.[0];
    declared = main && pbx.version.length === 1 && pbx.build.length === 1
      ? { [main.target]: { version: pbx.version[0], build: pbx.build[0] } } : {};
  }
  if (ipaBundles?.length) checks.push(...checkIpaVsProject(ipaBundles, declared, source));
  return { source, dir: found.dir, checks };
}
