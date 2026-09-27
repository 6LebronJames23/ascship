import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import YAML from 'yaml';
import { unzipIpa, findBundles, readEntitlements, verifySignature, readProfile, readBundleInfo, targetName } from './ipa.js';
import { checkExpected, checkAllowed, checkBuiltins, checkProfile, snapshot } from './entitlements.js';
import { checkBundleConsistency, projectVersionChecks } from './versions.js';
import { checkListing } from './listing.js';
import { probeVideo, checkPreview } from './preview.js';
import { renderReport, summarize, c } from './render.js';

const DISTRIBUTIONS = ['app-store', 'ad-hoc', 'development', 'enterprise'];

export function loadConfig(path) {
  if (!existsSync(path)) return { doc: new YAML.Document({}), data: {} };
  const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
  if (doc.errors.length) throw new Error(`${path}: ${doc.errors[0].message}`);
  return { doc, data: doc.toJS() ?? {} };
}

function ipaSections(ipaPath, { config, distribution }) {
  const ipa = unzipIpa(ipaPath);
  try {
    const paths = findBundles(ipa.app);
    const mainProfile = readProfile(ipa.app);
    const dist = distribution ?? mainProfile?.distribution ?? 'app-store';
    const expectations = config.entitlements ?? {};

    const bundles = paths.map((path) => {
      const target = targetName(path);
      const { bundleId, version, build } = readBundleInfo(path);
      const actual = readEntitlements(path);
      const profile = readProfile(path);
      const sig = verifySignature(path);
      const checks = [
        sig.ok
          ? { status: 'pass', id: 'signature.valid', message: 'signature valid' }
          : { status: 'fail', id: 'signature.invalid', message: `signature invalid: ${sig.error}` },
        ...checkProfile(profile, { mainTeamId: mainProfile?.teamId }),
      ];
      const expected = expectations[target]?.[dist];
      if (expected) {
        checks.push(...checkExpected(actual, expected, { profile: profile?.entitlements }));
      } else {
        checks.push({
          status: 'warn', id: 'expected.none',
          message: `no expected entitlements for ${target} (${dist}) in ascship.yaml`,
          hint: 'Run `ascship doctor --ipa <known-good.ipa> --snapshot` to record them.',
        });
      }
      if (profile) checks.push(...checkAllowed(actual, profile.entitlements));
      checks.push(...checkBuiltins(actual, { distribution: dist, teamId: profile?.teamId, bundleId }));
      return { kind: 'bundle', name: target, detail: bundleId, target, bundleId, version, build, entitlements: actual, checks };
    });
    return { distribution: dist, bundles };
  } finally {
    ipa.cleanup();
  }
}

function previewFiles(list, baseDir) {
  return list.flatMap((p) => {
    const abs = resolve(baseDir, p);
    if (!existsSync(abs)) throw new Error(`preview not found: ${p}`);
    return statSync(abs).isDirectory()
      ? readdirSync(abs).filter((f) => /\.(mp4|mov|m4v)$/i.test(f)).sort().map((f) => join(abs, f))
      : [abs];
  });
}

export function runDoctor({ ipa, project, config = {}, configPath = 'ascship.yaml', distribution, previews } = {}) {
  if (distribution && !DISTRIBUTIONS.includes(distribution)) {
    throw new Error(`--dist must be one of ${DISTRIBUTIONS.join(', ')}`);
  }
  const report = { sections: [] };

  let bundles = [];
  if (ipa) {
    const r = ipaSections(ipa, { config, distribution });
    report.ipa = basename(ipa);
    report.distribution = r.distribution;
    bundles = r.bundles;
    report.sections.push(...bundles);
  }

  const versionChecks = bundles.length ? checkBundleConsistency(bundles) : [];
  const proj = projectVersionChecks(project ?? dirname(resolve(configPath)), bundles);
  if (project && !proj) throw new Error(`no project.yml or .xcodeproj found at ${project}`);
  if (proj) versionChecks.push(...proj.checks);
  if (versionChecks.length) {
    report.sections.push({ kind: 'versions', name: 'Versions', detail: proj?.source, checks: versionChecks });
  }

  report.sections.push(...checkListing(config.listing));

  const previewList = previews?.length ? previews : config.previews ?? [];
  const base = previews?.length ? process.cwd() : dirname(resolve(configPath));
  for (const file of previewFiles(previewList, base)) {
    let checks;
    try {
      checks = checkPreview(probeVideo(file));
    } catch (e) {
      checks = [{ status: 'fail', id: 'preview.unreadable', message: e.message }];
    }
    report.sections.push({ kind: 'preview', name: `Preview ${basename(file)}`, checks });
  }

  if (!report.sections.length) {
    throw new Error('nothing to check: pass --ipa or --preview, run inside a project, or add listing:/previews: to ascship.yaml');
  }
  return Object.assign(report, summarize(report.sections));
}

// Record a known-good build's entitlements as the expectations in ascship.yaml.
export function writeSnapshot(report, configPath) {
  const { doc } = loadConfig(configPath);
  const bundles = report.sections.filter((s) => s.kind === 'bundle');
  for (const b of bundles) {
    doc.setIn(['entitlements', b.target, report.distribution], snapshot(b.entitlements));
  }
  writeFileSync(configPath, doc.toString());
  return bundles.map((b) => b.target);
}

export function render(report, opts) {
  const head = report.ipa ? ` ${c.dim('·')} ${report.ipa} ${c.dim(`(${report.distribution})`)}` : '';
  return renderReport(`${c.bold('ascship doctor')}${head}`, report, opts);
}
