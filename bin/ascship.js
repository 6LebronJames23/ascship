#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { runDoctor, loadConfig, writeSnapshot, render } from '../src/doctor.js';
import { runInit } from '../src/init.js';
import { client } from '../src/asc.js';
import { fetchStatus, deriveStatus } from '../src/status.js';
import { renderReport, c } from '../src/render.js';
import { createInterface } from 'node:readline/promises';
import { writeFileSync } from 'node:fs';
import { loadCredentials } from '../src/asc.js';
import { describeProject, bundleIdsFor } from '../src/project.js';
import { fetchSigningState, planProfiles, applyPlan } from '../src/profile.js';
import { runBuild } from '../src/build.js';
import { fetchListing, toYaml, diffListing, applyListing, preflight } from '../src/listing-sync.js';
import { fetchSubmitState, planSubmit, planCancel, applyOps } from '../src/submit.js';

const HELP = `ascship — ship iOS apps from the terminal

Usage:
  ascship init    [--key <AuthKey_X.p8>] [--key-id <id>] [--issuer <uuid>] [--app <bundle id>]
  ascship status  [--app <bundle id>]
  ascship doctor  [--ipa <path>] [--project <path>] [--preview <file>]...
  ascship profile [--type app-store|ad-hoc|development] [--bundle-id <id>]...
  ascship build   [--upload] [--regenerate] [--output <dir>]
  ascship listing pull | push
  ascship submit  [--app-version <x.y>] [--build <n>] [--release auto|manual|<date>] [--no-encryption]
  ascship submit  --cancel

init     Find your App Store Connect API key (~/.appstoreconnect/private_keys),
         verify it, save credentials to ~/.config/ascship (not your repo),
         and record the app in ascship.yaml.
status   Live version, version in progress, open review submissions, recent builds.
         Flags what is stuck: rejected submissions, unsubmitted drafts, failed
         builds, export compliance, approved-but-unreleased versions.
profile  Ensure every bundle (app + extensions) has an active profile signed by a
         certificate whose key is on this Mac; reuse or create, install, record in
         ascship.yaml. Never deletes profiles.
build    Archive, export with manual signing, run doctor on the IPA, and with
         --upload send it to App Store Connect (only if doctor passes).
listing  pull: write the live/in-progress listing into ascship.yaml.
         push: check it, show the diff, update only changed fields.
submit   Create/pick the version, attach the newest processed build, check the
         listing and screenshots, and submit for review. --cancel withdraws it.
doctor   Offline pre-upload checks:
           IPA       signature, profile, entitlements, bundle versions  (--ipa)
           Versions  IPA vs project.yml vs generated project            (--project)
           Listing   lengths, emoji, keyword waste          (listing: in ascship.yaml)
           Previews  audio track, 15-30s, <=30 fps, size     (--preview, or previews:)

Options:
  --config <path>    Config file (default: ascship.yaml)
  --app <id>         App by bundle id, Apple id or name (default: app: in ascship.yaml)
  --dry-run          profile/build/listing push/submit: show what would happen, change nothing
  -y, --yes          Don't ask for confirmation (required for listing push/submit without a terminal)
  --dist <type>      doctor: app-store | ad-hoc | development | enterprise
  --snapshot         doctor: record this IPA's entitlements as the expected set
  --json             Machine-readable output
  -v, --verbose      Show every passing check
  -h, --help         Show this help
  --version          Show version

CI: set ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY (the .p8 contents) or ASC_KEY_PATH.
Exit codes: 0 ok, 1 checks failed, 2 usage or runtime error.`;

const fail = (msg, json) => {
  if (json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`ascship: ${msg}`);
  process.exit(2);
};

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      ipa: { type: 'string' }, project: { type: 'string' }, preview: { type: 'string', multiple: true },
      config: { type: 'string', default: 'ascship.yaml' }, dist: { type: 'string' }, snapshot: { type: 'boolean' },
      app: { type: 'string' }, key: { type: 'string' }, 'key-id': { type: 'string' }, issuer: { type: 'string' },
      type: { type: 'string', default: 'app-store' }, 'bundle-id': { type: 'string', multiple: true },
      upload: { type: 'boolean' }, regenerate: { type: 'boolean' }, output: { type: 'string' },
      'dry-run': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' },
      build: { type: 'string' }, 'app-version': { type: 'string' }, release: { type: 'string' }, 'no-encryption': { type: 'boolean' }, cancel: { type: 'boolean' },
      json: { type: 'boolean' }, verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    },
  });
} catch (e) {
  fail(e.message);
}
const { values: o, positionals: [cmd, sub] } = args;
const out = (report, text) => console.log(o.json ? JSON.stringify(report, null, 2) : text);

if (o.version) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  process.exit(0);
}
if (o.help || !cmd) {
  console.log(HELP);
  process.exit(o.help ? 0 : 2);
}

async function confirm(question) {
  if (o.yes) return true;
  if (!process.stdin.isTTY || o.json) fail(`${question.replace(/\?.*$/, '')} needs confirmation; pass --yes`, o.json);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

async function resolveApp(api) {
  const ref = o.app ?? loadConfig(o.config).data.app?.id;
  if (!ref) fail('no app: pass --app <bundle id>, or run `ascship init` to record one in ascship.yaml', o.json);
  if (/^\d+$/.test(ref)) return ref;
  const res = await api.get(`/v1/apps?filter[bundleId]=${encodeURIComponent(ref)}&fields[apps]=name`);
  if (!res.data?.length) fail(`no app with bundle id ${ref} on this account`, o.json);
  return res.data[0].id;
}

const short = (v) => (v === null || v === undefined ? c.dim('(empty)') : JSON.stringify(String(v).length > 60 ? String(v).slice(0, 57) + '…' : String(v)));
const dry = () => o['dry-run'];

const commands = {
  async init() {
    const r = await runInit({ key: o.key, keyId: o['key-id'], issuer: o.issuer, app: o.app, config: o.config, json: o.json });
    if (o.json) return out({ ok: true, ...r });
    console.log(`${c.green('✓')} API key ${r.keyId} works (${r.apps} app${r.apps === 1 ? '' : 's'} on this account)`);
    console.log(`${c.green('✓')} credentials saved to ${r.credentialsFile} ${c.dim('(outside your repo)')}`);
    if (r.app) console.log(`${c.green('✓')} ${r.config}: app ${r.app.name} (${r.app.bundleId})`);
    else console.log(`${c.yellow('!')} no app picked; run \`ascship init --app <bundle id>\``);
  },

  async status() {
    const appRef = o.app ?? loadConfig(o.config).data.app?.id;
    if (!appRef) fail('no app: pass --app <bundle id>, or run `ascship init` to record one in ascship.yaml', o.json);
    const api = client();
    let appId = appRef;
    if (!/^\d+$/.test(appRef)) {
      const res = await api.get(`/v1/apps?filter[bundleId]=${encodeURIComponent(appRef)}&fields[apps]=name`);
      if (!res.data?.length) fail(`no app with bundle id ${appRef} on this account`, o.json);
      appId = res.data[0].id;
    }
    const report = deriveStatus(await fetchStatus(api, appId));
    out(report, renderReport(`${c.bold('ascship status')} ${c.dim('·')} ${report.app.name} ${c.dim(report.app.bundleId)}`, report, {
      failLine: 'Needs attention.',
    }));
    process.exit(report.ok ? 0 : 1);
  },

  async profile() {
    const { doc, data: config } = loadConfig(o.config);
    const project = describeProject(o.project ?? '.');
    const bundleIds = o['bundle-id']?.length ? o['bundle-id'] : bundleIdsFor(project, config);
    if (!bundleIds.length) fail('no bundle ids: pass --bundle-id, run inside a project with project.yml, or run `ascship init`', o.json);
    const api = client();
    const plan = planProfiles({ type: o.type, bundleIds, ...(await fetchSigningState(api, o.type, bundleIds)) });
    const summary = plan.items.map((i) => ({ bundleId: i.bundleId, action: i.action, profile: i.profile?.name ?? i.name, registerBundle: !!i.registerBundle }));
    if (!o.json) {
      console.log(`${c.bold('ascship profile')} ${c.dim('·')} ${o.type} ${c.dim('·')} signing with ${plan.identity.name}${o['dry-run'] ? c.dim('  (dry run)') : ''}\n`);
      for (const i of plan.items) {
        console.log(i.action === 'reuse'
          ? `  ${c.green('✓')} ${i.bundleId}  reuse "${i.profile.name}" ${c.dim(`(expires ${i.profile.expirationDate.slice(0, 10)})`)}`
          : `  ${c.yellow('+')} ${i.bundleId}  ${i.registerBundle ? 'register bundle id, ' : ''}create "${i.name}"`);
      }
    }
    if (dry()) return out({ ok: true, dryRun: true, type: o.type, items: summary }, '');
    const mapping = await applyPlan(api, plan, { log: (m) => !o.json && console.log(`  ${c.dim(m)}`) });
    doc.setIn(['signing', o.type], { teamId: plan.teamId, certificate: plan.identity.name, profiles: mapping });
    writeFileSync(o.config, doc.toString());
    out({ ok: true, type: o.type, teamId: plan.teamId, profiles: mapping },
      `\n${c.green('✓')} ${Object.keys(mapping).length} profile${Object.keys(mapping).length === 1 ? '' : 's'} installed; recorded in ${o.config} under signing.${o.type}`);
  },

  async build() {
    const config = loadConfig(o.config).data;
    const creds = o.upload ? loadCredentials() : undefined;
    const r = await runBuild({ project: o.project, config, configPath: o.config, output: o.output, upload: o.upload, regenerate: o.regenerate, dryRun: dry() },
      { creds, log: (m) => !o.json && console.log(c.dim(m)) });
    if (r.dryRun) {
      return out({ ok: true, ...r }, [c.bold('ascship build (dry run)'), '', '$ ' + r.plan.archive.join(' '), '', '$ ' + r.plan.export.join(' '),
        r.plan.upload ? '\n$ ' + r.plan.upload.join(' ') : '', '', c.dim('ExportOptions.plist:'), r.plan.exportOptions].join('\n'));
    }
    out({ ok: r.report.ok, ipa: r.ipa, uploaded: r.uploaded, report: r.report }, [render(r.report, { verbose: o.verbose }), '',
      r.uploaded ? `${c.green('✓')} uploaded ${r.ipa}. Processing takes 5-30 minutes; then \`ascship submit\`.`
        : `IPA: ${r.ipa}${o.upload ? '' : c.dim('  (not uploaded; pass --upload)')}`].join('\n'));
    process.exit(r.report.ok ? 0 : 1);
  },

  async listing() {
    if (!['pull', 'push'].includes(sub)) fail('usage: ascship listing pull | push', o.json);
    const api = client();
    const appId = await resolveApp(api);
    const remote = await fetchListing(api, appId);
    const { doc, data: config } = loadConfig(o.config);

    if (sub === 'pull') {
      const listing = toYaml(remote);
      doc.setIn(['listing'], listing);
      writeFileSync(o.config, doc.toString());
      return out({ ok: true, locales: Object.keys(listing), version: remote.shown.versionString },
        `${c.green('✓')} wrote ${Object.keys(listing).length} locale${Object.keys(listing).length === 1 ? '' : 's'} (${Object.keys(listing).join(', ')}) from ${remote.shown.versionString ?? 'the app'} into ${o.config}`);
    }

    if (!config.listing) fail(`no listing: in ${o.config}. Run \`ascship listing pull\` first.`, o.json);
    const problems = preflight(config.listing).filter((x) => x.status === 'fail');
    if (problems.length) {
      out({ ok: false, problems }, problems.map((p) => `${c.red('✗')} ${p.message}`).join('\n') + `\n${c.red('not pushing; fix these in ' + o.config)}`);
      process.exit(1);
    }
    const { ops, blocked, notes } = diffListing(config.listing, remote);
    if (!o.json) {
      console.log(`${c.bold('ascship listing push')}${dry() ? c.dim('  (dry run)') : ''}\n`);
      for (const op of ops) {
        console.log(`${op.locale} ${c.dim(op.label)}${op.create ? c.dim(' (new localization)') : ''}`);
        for (const [k, v] of Object.entries(op.changes)) console.log(`  ${k}: ${short(op.before[k])} → ${short(v)}`);
      }
      for (const n of notes) console.log(`${c.blue('·')} ${n}`);
      for (const b of blocked) console.log(`${c.yellow('!')} ${b}`);
      if (!ops.length) console.log(blocked.length ? '' : `${c.green('✓')} App Store Connect already matches ${o.config}`);
    }
    if (dry() || !ops.length) return o.json && out({ ok: true, dryRun: dry(), ops, blocked, notes });
    if (!(await confirm(`\nUpdate ${ops.length} localization${ops.length === 1 ? '' : 's'} on App Store Connect?`))) return console.log('cancelled');
    await applyListing(api, ops);
    out({ ok: true, ops, blocked, notes }, `${c.green('✓')} updated`);
  },

  async submit() {
    const api = client();
    const appId = await resolveApp(api);
    let state = await fetchSubmitState(api, appId);
    const log = (m) => !o.json && console.log(m);

    if (o.cancel) {
      const ops = planCancel(state);
      ops.forEach((op) => log(`  ${op.desc}`));
      if (dry()) return out({ ok: true, dryRun: true, ops }, '');
      if (!(await confirm('Withdraw from review?'))) return console.log('cancelled');
      await applyOps(api, ops, { log });
      return out({ ok: true, canceled: ops.length }, 'Canceling takes up to a minute; then attach a new build or resubmit.');
    }

    const opts = { version: o['app-version'], build: o.build, release: o.release, noEncryption: o['no-encryption'] };
    let plan = planSubmit(state, opts);
    const show = (p) => {
      log(`${c.bold('ascship submit')} ${c.dim('·')} ${p.version.versionString} (${p.build.version})${dry() ? c.dim('  (dry run)') : ''}\n`);
      p.ops.forEach((op) => log(`  ${c.dim('→')} ${op.desc}`));
      if (p.checks.length) log('');
      p.checks.forEach((x) => log(`  ${{ fail: c.red('✗'), warn: c.yellow('!'), info: c.blue('·'), pass: c.green('✓') }[x.status]} ${x.message}${x.hint ? '\n    ' + c.dim('↳ ' + x.hint) : ''}`));
      log('');
    };
    show(plan);
    if (dry()) return out({ ok: plan.ok, dryRun: true, ops: plan.ops, checks: plan.checks });

    // A brand-new version gets created first, then checked as App Review will see it.
    if (plan.version.created) {
      const prep = plan.ops.filter((op) => !op.id.startsWith('submission.'));
      if (!(await confirm(`Create ${plan.version.versionString} and attach build ${plan.build.version}?`))) return console.log('cancelled');
      await applyOps(api, prep, { log });
      state = await fetchSubmitState(api, appId);
      plan = planSubmit(state, { ...opts, version: undefined });
      log('');
      show(plan);
    }
    if (!plan.ok) {
      out({ ok: false, checks: plan.checks }, c.red('✗ not submitting; fix the problems above and run `ascship submit` again.'));
      process.exit(1);
    }
    if (!(await confirm(`Submit ${plan.version.versionString} (${plan.build.version}) for App Review?`))) return console.log('cancelled');
    await applyOps(api, plan.ops, { log });
    out({ ok: true, version: plan.version.versionString, build: plan.build.version }, `${c.green('✓')} submitted. Track it with \`ascship status\`.`);
  },

  async doctor() {
    if (process.platform !== 'darwin') fail('doctor needs macOS (it uses codesign and security)', o.json);
    if (o.snapshot && !o.ipa) fail('--snapshot needs --ipa <known-good.ipa>', o.json);
    const report = runDoctor({
      ipa: o.ipa, project: o.project, previews: o.preview, distribution: o.dist,
      config: loadConfig(o.config).data, configPath: o.config,
    });
    if (o.snapshot) {
      const targets = writeSnapshot(report, o.config);
      if (o.json) return out({ ok: true, snapshot: { config: o.config, distribution: report.distribution, targets } });
      return console.log(`recorded ${report.distribution} entitlements for ${targets.join(', ')} in ${o.config}`);
    }
    out(report, render(report, { verbose: o.verbose }));
    process.exit(report.ok ? 0 : 1);
  },
};

if (!commands[cmd]) fail(`unknown command "${cmd}" (commands: ${Object.keys(commands).join(', ')})`, o.json);
try {
  await commands[cmd]();
} catch (e) {
  fail(e.message, o.json);
}
