#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { runDoctor, loadConfig, writeSnapshot, render } from '../src/doctor.js';

const HELP = `ascship — ship iOS apps from the terminal

Usage:
  ascship doctor [--ipa <path>] [--project <path>] [--preview <file>]... [options]

Runs every check it has inputs for:
  IPA        signature, profile, entitlements, bundle versions   (--ipa)
  Versions   IPA vs project.yml vs generated project              (--project, or
             auto-detected next to ascship.yaml)
  Listing    lengths, emoji, keyword waste                        (listing: in ascship.yaml)
  Previews   audio track, 15-30s, <=30 fps, size                  (--preview, or previews:)

Options:
  --ipa <path>       Exported .ipa to check
  --project <path>   project.yml, .xcodeproj, or the folder containing them
  --preview <file>   App Preview video or folder (repeatable)
  --config <path>    Config file (default: ascship.yaml)
  --dist <type>      app-store | ad-hoc | development | enterprise
                     (default: detected from the embedded profile)
  --snapshot         Record this IPA's entitlements as the expected set
  --json             Machine-readable output
  -v, --verbose      Show every passing check
  -h, --help         Show this help
  --version          Show version

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
      ipa: { type: 'string' }, project: { type: 'string' }, preview: { type: 'string', multiple: true }, config: { type: 'string', default: 'ascship.yaml' }, dist: { type: 'string' },
      snapshot: { type: 'boolean' }, json: { type: 'boolean' }, verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    },
  });
} catch (e) {
  fail(e.message);
}
const { values: o, positionals: [cmd] } = args;

if (o.version) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  process.exit(0);
}
if (o.help || !cmd) {
  console.log(HELP);
  process.exit(o.help ? 0 : 2);
}
if (cmd !== 'doctor') fail(`unknown command "${cmd}" (try: ascship doctor --ipa <path>)`, o.json);
if (process.platform !== 'darwin') fail('doctor needs macOS (it uses codesign and security)', o.json);
if (o.snapshot && !o.ipa) fail('--snapshot needs --ipa <known-good.ipa>', o.json);

try {
  const report = runDoctor({
    ipa: o.ipa, project: o.project, previews: o.preview, distribution: o.dist,
    config: loadConfig(o.config).data, configPath: o.config,
  });
  if (o.snapshot) {
    const targets = writeSnapshot(report, o.config);
    const msg = `recorded ${report.distribution} entitlements for ${targets.join(', ')} in ${o.config}`;
    if (o.json) console.log(JSON.stringify({ ok: true, snapshot: { config: o.config, distribution: report.distribution, targets } }));
    else console.log(msg);
    process.exit(0);
  }
  console.log(o.json ? JSON.stringify(report, null, 2) : render(report, { verbose: o.verbose }));
  process.exit(report.ok ? 0 : 1);
} catch (e) {
  fail(e.message, o.json);
}
