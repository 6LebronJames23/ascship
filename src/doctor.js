import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import YAML from 'yaml';
import { unzipIpa, findBundles, readEntitlements, verifySignature, readProfile, readBundleId, targetName } from './ipa.js';
import { checkExpected, checkAllowed, checkBuiltins, checkProfile, snapshot } from './entitlements.js';

const DISTRIBUTIONS = ['app-store', 'ad-hoc', 'development', 'enterprise'];

export function loadConfig(path) {
  if (!existsSync(path)) return { doc: new YAML.Document({}), data: {} };
  const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
  if (doc.errors.length) throw new Error(`${path}: ${doc.errors[0].message}`);
  return { doc, data: doc.toJS() ?? {} };
}

export function doctorIpa(ipaPath, { config = {}, distribution } = {}) {
  if (distribution && !DISTRIBUTIONS.includes(distribution)) {
    throw new Error(`--dist must be one of ${DISTRIBUTIONS.join(', ')}`);
  }
  const ipa = unzipIpa(ipaPath);
  try {
    const paths = findBundles(ipa.app);
    const mainProfile = readProfile(ipa.app);
    const dist = distribution ?? mainProfile?.distribution ?? 'app-store';
    const expectations = config.entitlements ?? {};

    const bundles = paths.map((path) => {
      const target = targetName(path);
      const bundleId = readBundleId(path);
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
      return { target, bundleId, entitlements: actual, checks };
    });

    const all = bundles.flatMap((b) => b.checks);
    const count = (s) => all.filter((c) => c.status === s).length;
    const summary = { pass: count('pass'), warn: count('warn'), fail: count('fail') };
    return { ipa: basename(ipaPath), distribution: dist, ok: summary.fail === 0, summary, bundles };
  } finally {
    ipa.cleanup();
  }
}

// Record a known-good build's entitlements as the expectations in ascship.yaml.
export function writeSnapshot(report, configPath) {
  const { doc } = loadConfig(configPath);
  for (const b of report.bundles) {
    doc.setIn(['entitlements', b.target, report.distribution], snapshot(b.entitlements));
  }
  writeFileSync(configPath, doc.toString());
  return report.bundles.map((b) => b.target);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { green: paint(32), yellow: paint(33), red: paint(31), dim: paint(2), bold: paint(1) };
const MARK = { pass: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗') };

export function render(report, { verbose = false } = {}) {
  const lines = [`${c.bold('ascship doctor')} ${c.dim('·')} ${report.ipa} ${c.dim(`(${report.distribution})`)}`, ''];
  for (const b of report.bundles) {
    lines.push(`${c.bold(b.target)}  ${c.dim(b.bundleId ?? '')}`);
    for (const chk of b.checks) {
      if (chk.status === 'pass' && !verbose && chk.id === 'expected.ok') continue;
      lines.push(`  ${MARK[chk.status]} ${chk.message}`);
      if (chk.hint && chk.status !== 'pass') lines.push(`    ${c.dim('↳ ' + chk.hint)}`);
    }
    const ok = b.checks.filter((x) => x.id === 'expected.ok').length;
    if (ok && !verbose) lines.push(`  ${MARK.pass} ${ok} expected entitlement${ok === 1 ? '' : 's'} present`);
    lines.push('');
  }
  const { pass, warn, fail } = report.summary;
  const tally = `${pass} passed, ${warn} warning${warn === 1 ? '' : 's'}, ${fail} failed`;
  lines.push(fail ? c.red(`✗ ${tally}. Do not upload this build.`) : c.green(`✓ ${tally}.`));
  return lines.join('\n');
}
