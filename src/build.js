// `ascship build`: archive → export (manual signing with the profiles from
// `ascship profile`) → doctor → optional upload. Stops before uploading anything
// doctor fails, and never uploads without --upload.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, createWriteStream, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { describeProject } from './project.js';
import { projectVersionChecks } from './versions.js';
import { runDoctor } from './doctor.js';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function exportOptionsPlist({ teamId, profiles, method = 'app-store-connect', certificate = 'Apple Distribution' }) {
  const entries = Object.entries(profiles)
    .map(([id, name]) => `    <key>${xml(id)}</key><string>${xml(name)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>${xml(method)}</string>
  <key>teamID</key><string>${xml(teamId)}</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>${xml(certificate)}</string>
  <key>provisioningProfiles</key>
  <dict>
${entries}
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
  <key>destination</key><string>export</string>
</dict>
</plist>
`;
}

export function buildPlan({ project, config, output, configuration = 'Release' }) {
  const signing = config.signing?.['app-store'];
  if (!signing?.profiles || !Object.keys(signing.profiles).length) {
    throw new Error('no App Store profiles recorded in ascship.yaml. Run `ascship profile` first.');
  }
  if (!signing.teamId) throw new Error('ascship.yaml signing.app-store.teamId is missing. Run `ascship profile` again.');
  const scheme = config.build?.scheme ?? project.scheme;
  if (!scheme) throw new Error('could not tell which scheme to archive; set build.scheme in ascship.yaml');
  const out = resolve(output ?? join(project.dir, 'build', 'ascship'));
  const archivePath = join(out, `${scheme}.xcarchive`);
  const exportPath = join(out, 'export');
  const exportOptions = join(out, 'ExportOptions.plist');
  const container = project.workspace ? ['-workspace', project.workspace] : ['-project', project.xcodeproj];
  return {
    out, archivePath, exportPath, exportOptions, scheme,
    exportOptionsContent: exportOptionsPlist({ teamId: signing.teamId, profiles: signing.profiles }),
    archive: ['xcodebuild', 'archive', ...container, '-scheme', scheme, '-configuration', configuration,
      '-destination', 'generic/platform=iOS', '-archivePath', archivePath, '-allowProvisioningUpdates',
      ...(config.build?.archiveArgs ?? [])],
    export: ['xcodebuild', '-exportArchive', '-archivePath', archivePath, '-exportPath', exportPath,
      '-exportOptionsPlist', exportOptions],
  };
}

function runLogged(argv, logFile, cwd) {
  return new Promise((done, fail) => {
    const log = createWriteStream(logFile);
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', (e) => fail(e));
    child.on('close', (code) => {
      log.end(() => {
        if (code === 0) return done();
        const lines = readFileSync(logFile, 'utf8').split('\n');
        const errors = lines.filter((l) => /(error:|\*\* .* FAILED \*\*|No profiles for|doesn't match|Provisioning profile)/.test(l)).slice(-12);
        fail(new Error(`${basename(argv[0])} ${argv[1]} failed (exit ${code}). Log: ${logFile}\n${(errors.length ? errors : lines.slice(-15)).join('\n')}`));
      });
    });
  });
}

export function uploadArgs(ipa, creds) {
  return ['xcrun', 'altool', '--upload-app', '-f', ipa, '-t', 'ios', '--apiKey', creds.keyId, '--apiIssuer', creds.issuerId, '--output-format', 'json'];
}

async function upload(ipa, creds, logFile) {
  // altool finds AuthKey_<id>.p8 via API_PRIVATE_KEYS_DIR; stage the key there when it came from an env var.
  let keyDir, temp;
  if (creds.keyPath && basename(creds.keyPath) === `AuthKey_${creds.keyId}.p8`) keyDir = dirname(creds.keyPath);
  else {
    temp = mkdtempSync(join(tmpdir(), 'ascship-key-'));
    writeFileSync(join(temp, `AuthKey_${creds.keyId}.p8`), creds.key ?? readFileSync(creds.keyPath), { mode: 0o600 });
    keyDir = temp;
  }
  const prev = process.env.API_PRIVATE_KEYS_DIR;
  process.env.API_PRIVATE_KEYS_DIR = keyDir;
  try {
    await runLogged(uploadArgs(ipa, creds), logFile);
    // altool can exit 0 and still report a rejected upload in its JSON.
    const text = readFileSync(logFile, 'utf8');
    const json = text.slice(text.indexOf('{'));
    let errors = [];
    try { errors = JSON.parse(json)['product-errors'] ?? []; } catch {}
    if (errors.length || /ERROR ITMS-\d+/.test(text)) {
      const msgs = errors.map((e) => e.message ?? JSON.stringify(e));
      throw new Error(`App Store Connect rejected the upload. Log: ${logFile}\n${(msgs.length ? msgs : text.match(/ERROR ITMS-\d+[^\n]*/g) ?? []).join('\n')}`);
    }
  } finally {
    if (prev === undefined) delete process.env.API_PRIVATE_KEYS_DIR; else process.env.API_PRIVATE_KEYS_DIR = prev;
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

export async function runBuild(opts, { log = console.log, creds } = {}) {
  const project = describeProject(opts.project ?? dirname(resolve(opts.configPath)));
  if (!project?.xcodeproj && !project?.workspace) throw new Error('no Xcode project found; pass --project');
  const plan = buildPlan({ project, config: opts.config, output: opts.output });

  // 1. Pre-flight: never archive a project whose generated files lag project.yml.
  const pre = projectVersionChecks(project.yml ?? project.xcodeproj, []);
  const stale = pre?.checks.filter((c) => c.status === 'fail') ?? [];
  if (stale.length && opts.regenerate && project.yml) {
    log('regenerating the project with xcodegen…');
    if (!opts.dryRun) execFileSync('xcodegen', ['generate', '--spec', project.yml], { cwd: project.dir, stdio: 'ignore' });
  } else if (stale.length) {
    throw new Error(`${stale.map((c) => c.message).join('; ')}. Re-run xcodegen, or pass --regenerate.`);
  }

  if (opts.dryRun) {
    return { dryRun: true, plan: { archive: plan.archive, export: plan.export, exportOptions: plan.exportOptionsContent, upload: opts.upload ? uploadArgs(join(plan.exportPath, '<App>.ipa'), creds ?? { keyId: '<key id>', issuerId: '<issuer>' }) : null } };
  }

  // 2. Archive and export.
  mkdirSync(join(plan.out, 'logs'), { recursive: true });
  rmSync(plan.archivePath, { recursive: true, force: true });
  rmSync(plan.exportPath, { recursive: true, force: true });
  writeFileSync(plan.exportOptions, plan.exportOptionsContent);
  log(`archiving ${plan.scheme}… (log: ${join(plan.out, 'logs', 'archive.log')})`);
  await runLogged(plan.archive, join(plan.out, 'logs', 'archive.log'), project.dir);
  log('exporting with manual signing…');
  await runLogged(plan.export, join(plan.out, 'logs', 'export.log'), project.dir);
  const ipaName = existsSync(plan.exportPath) && readdirSync(plan.exportPath).find((f) => f.endsWith('.ipa'));
  if (!ipaName) throw new Error(`export finished but no .ipa in ${plan.exportPath}`);
  const ipa = join(plan.exportPath, ipaName);

  // 3. Doctor the exported IPA; this is the artifact that would be uploaded.
  const report = runDoctor({ ipa, project: project.dir, config: opts.config, configPath: opts.configPath });

  // 4. Upload only when asked and only a clean build.
  let uploaded = false;
  if (opts.upload) {
    if (!report.ok) throw Object.assign(new Error('doctor found problems; not uploading'), { report, ipa });
    log('uploading to App Store Connect…');
    await upload(ipa, creds, join(plan.out, 'logs', 'upload.log'));
    uploaded = true;
  }
  return { ipa, report, uploaded };
}
