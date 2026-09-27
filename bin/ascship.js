#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { runDoctor, loadConfig, writeSnapshot, render } from '../src/doctor.js';
import { runInit } from '../src/init.js';
import { client } from '../src/asc.js';
import { fetchStatus, deriveStatus } from '../src/status.js';
import { renderReport, c } from '../src/render.js';

const HELP = `ascship — ship iOS apps from the terminal

Usage:
  ascship init   [--key <AuthKey_X.p8>] [--key-id <id>] [--issuer <uuid>] [--app <bundle id>]
  ascship status [--app <bundle id>]
  ascship doctor [--ipa <path>] [--project <path>] [--preview <file>]...

init     Find your App Store Connect API key (~/.appstoreconnect/private_keys),
         verify it, save credentials to ~/.config/ascship (not your repo),
         and record the app in ascship.yaml.
status   Live version, version in progress, open review submissions, recent builds.
         Flags what is stuck: rejected submissions, unsubmitted drafts, failed
         builds, export compliance, approved-but-unreleased versions.
doctor   Offline pre-upload checks:
           IPA       signature, profile, entitlements, bundle versions  (--ipa)
           Versions  IPA vs project.yml vs generated project            (--project)
           Listing   lengths, emoji, keyword waste          (listing: in ascship.yaml)
           Previews  audio track, 15-30s, <=30 fps, size     (--preview, or previews:)

Options:
  --config <path>    Config file (default: ascship.yaml)
  --app <id>         App by bundle id, Apple id or name (default: app: in ascship.yaml)
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
      json: { type: 'boolean' }, verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    },
  });
} catch (e) {
  fail(e.message);
}
const { values: o, positionals: [cmd] } = args;
const out = (report, text) => console.log(o.json ? JSON.stringify(report, null, 2) : text);

if (o.version) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  process.exit(0);
}
if (o.help || !cmd) {
  console.log(HELP);
  process.exit(o.help ? 0 : 2);
}

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
