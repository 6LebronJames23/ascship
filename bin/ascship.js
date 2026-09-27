#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { doctorIpa, loadConfig, writeSnapshot, render } from '../src/doctor.js';

const HELP = `ascship — ship iOS apps from the terminal

Usage:
  ascship doctor --ipa <path> [options]

Options:
  --ipa <path>       Exported .ipa to check (required)
  --config <path>    Config file (default: ascship.yaml)
  --dist <type>      app-store | ad-hoc | development | enterprise
                     (default: detected from the embedded profile)
  --snapshot         Record this build's entitlements as the expected set
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
      ipa: { type: 'string' }, config: { type: 'string', default: 'ascship.yaml' }, dist: { type: 'string' },
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
if (!o.ipa) fail('--ipa <path> is required', o.json);

try {
  const report = doctorIpa(o.ipa, { config: loadConfig(o.config).data, distribution: o.dist });
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
