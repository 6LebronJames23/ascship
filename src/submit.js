// `ascship submit`: version → build → checks → review submission.
// Planning is pure (planSubmit); applying runs the planned API calls in order.
import { hydrate } from './asc.js';
import { checkLocale } from './listing.js';

const check = (status, id, message, extra = {}) => ({ status, id, message, ...extra });
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);
const vstate = (v) => v.appVersionState ?? v.appStoreState;
const RELEASE = { auto: 'AFTER_APPROVAL', manual: 'MANUAL' };

export async function fetchSubmitState(api, appId) {
  const [versions, builds, submissions] = await Promise.all([
    api.get(`/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=10`
      + '&fields[appStoreVersions]=versionString,appVersionState,appStoreState,createdDate,releaseType,build,appStoreVersionLocalizations'
      + '&include=build,appStoreVersionLocalizations&limit[appStoreVersionLocalizations]=50&fields[builds]=version'),
    api.get(`/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=20`
      + '&fields[builds]=version,processingState,uploadedDate,expired,usesNonExemptEncryption,preReleaseVersion'
      + '&include=preReleaseVersion&fields[preReleaseVersions]=version'),
    api.get(`/v1/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&limit=10`
      + '&fields[reviewSubmissions]=state,submittedDate,items&include=items&fields[reviewSubmissionItems]=appStoreVersion'),
  ]);
  const state = { appId, versions: hydrate(versions), builds: hydrate(builds), submissions: hydrate(submissions), screenshots: {} };
  // Screenshot counts for the editable version's localizations.
  const editable = state.versions.find((v) => EDITABLE.has(vstate(v)));
  for (const loc of editable?.appStoreVersionLocalizations ?? []) {
    const sets = hydrate(await api.get(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?include=appScreenshots&limit=50&fields[appScreenshotSets]=screenshotDisplayType,appScreenshots`));
    state.screenshots[loc.locale] = sets.reduce((n, s) => n + (s.appScreenshots?.length ?? 0), 0);
  }
  return state;
}

// Pure. Returns { ops, checks, version, build }; ops are API calls in order.
export function planSubmit(state, opts = {}) {
  const ops = [], checks = [];
  const blockers = state.submissions.filter((s) => ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES', 'CANCELING'].includes(s.state));
  if (blockers.length) {
    const s = blockers[0];
    const why = s.state === 'UNRESOLVED_ISSUES' ? 'a rejected submission is still open'
      : s.state === 'CANCELING' ? 'a submission is still canceling; try again in a minute'
        : `a submission is already ${s.state.replaceAll('_', ' ').toLowerCase()}`;
    throw new Error(`${why}. ${s.state === 'CANCELING' ? '' : 'Run `ascship submit --cancel` to withdraw it first.'}`.trim());
  }

  // 1. Version.
  const sorted = [...state.versions].sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
  let version = sorted.find((v) => EDITABLE.has(vstate(v)));
  const live = sorted.find((v) => vstate(v) === 'READY_FOR_DISTRIBUTION');
  if (!version) {
    if (!opts.version) {
      const pending = sorted.find((v) => !['READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION'].includes(vstate(v)));
      throw new Error(pending
        ? `${pending.versionString} is ${vstate(pending).replaceAll('_', ' ').toLowerCase()}; nothing to submit`
        : `no version in progress. Pass --app-version <x.y> to create one${live ? ` (live is ${live.versionString})` : ''}.`);
    }
    ops.push({ id: 'version.create', desc: `create version ${opts.version}`, method: 'post', path: '/v1/appStoreVersions',
      body: { data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: opts.version },
        relationships: { app: { data: { type: 'apps', id: state.appId } } } } } });
    version = { id: '$version', versionString: opts.version, appStoreVersionLocalizations: null, created: true };
  } else if (opts.version && opts.version !== version.versionString) {
    if (vstate(version) !== 'PREPARE_FOR_SUBMISSION') throw new Error(`the version in progress is ${version.versionString}; --app-version ${opts.version} does not match`);
    ops.push({ id: 'version.rename', desc: `rename version ${version.versionString} → ${opts.version}`, method: 'patch', path: `/v1/appStoreVersions/${version.id}`,
      body: { data: { type: 'appStoreVersions', id: version.id, attributes: { versionString: opts.version } } } });
    version = { ...version, versionString: opts.version };
  }

  // 2. Build: explicit, or the newest processed build for this version string.
  const forVersion = state.builds.filter((b) => b.preReleaseVersion?.version === version.versionString && !b.expired);
  const build = opts.build
    ? state.builds.find((b) => b.version === String(opts.build) && (!b.preReleaseVersion || b.preReleaseVersion.version === version.versionString))
    : forVersion.find((b) => b.processingState === 'VALID') ?? forVersion[0];
  if (!build) {
    throw new Error(opts.build
      ? `build ${opts.build} for ${version.versionString} not found`
      : `no build uploaded for ${version.versionString}. Upload one with \`ascship build --upload\` (processing takes 5-30 minutes).`);
  }
  if (build.processingState !== 'VALID') throw new Error(`build ${build.version} is ${build.processingState}; wait for it to finish processing`);
  if (build.usesNonExemptEncryption === null || build.usesNonExemptEncryption === undefined) {
    if (!opts.noEncryption) {
      throw new Error(`build ${build.version} has no export compliance answer. If the app only uses standard HTTPS/OS encryption, pass --no-encryption (and add ITSAppUsesNonExemptEncryption = NO to Info.plist so future builds don't ask).`);
    }
    ops.push({ id: 'build.encryption', desc: `answer export compliance for build ${build.version}: exempt encryption only`, method: 'patch', path: `/v1/builds/${build.id}`,
      body: { data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } } } });
  }
  if (version.build?.id !== build.id) {
    ops.push({ id: 'version.attach', desc: `attach build ${build.version} to ${version.versionString}`, method: 'patch', path: `/v1/appStoreVersions/${version.id}/relationships/build`,
      body: { data: { type: 'builds', id: build.id } } });
  }

  // 3. Release type.
  if (opts.release) {
    const attrs = RELEASE[opts.release] ? { releaseType: RELEASE[opts.release] }
      : !Number.isNaN(Date.parse(opts.release)) ? { releaseType: 'SCHEDULED', earliestReleaseDate: new Date(opts.release).toISOString() } : null;
    if (!attrs) throw new Error('--release must be auto, manual, or a date (2026-10-01T09:00:00Z)');
    ops.push({ id: 'version.release', desc: `release: ${attrs.releaseType.toLowerCase().replaceAll('_', ' ')}${attrs.earliestReleaseDate ? ` ${attrs.earliestReleaseDate}` : ''}`,
      method: 'patch', path: `/v1/appStoreVersions/${version.id}`, body: { data: { type: 'appStoreVersions', id: version.id, attributes: attrs } } });
  }

  // 4. Pre-flight on what App Review will see.
  if (version.created) {
    checks.push(check('info', 'submit.new-version', `${version.versionString} will be created; App Store Connect copies the listing and screenshots from the previous version`));
  } else {
    const locs = version.appStoreVersionLocalizations ?? [];
    if (!locs.length) checks.push(check('fail', 'submit.no-localization', `${version.versionString} has no localizations`));
    for (const l of locs) {
      if (!l.description?.trim()) checks.push(check('fail', 'submit.description', `${l.locale}: description is empty`));
      if (live && !l.whatsNew?.trim()) checks.push(check('fail', 'submit.whats-new', `${l.locale}: What's New is empty (required for updates)`, { hint: 'Set it with `ascship listing push`.' }));
      if (!l.keywords?.trim()) checks.push(check('warn', 'submit.keywords', `${l.locale}: no keywords`));
      if ((state.screenshots[l.locale] ?? 0) === 0) checks.push(check('fail', 'submit.screenshots', `${l.locale}: no screenshots`));
      checks.push(...checkLocale(l.locale, Object.fromEntries(['description', 'keywords', 'promotionalText', 'whatsNew'].filter((k) => l[k]).map((k) => [k, l[k]])))
        .filter((c) => c.status !== 'pass'));
    }
  }
  checks.push(check('info', 'submit.app-privacy', 'App Privacy is not visible to the API: make sure it says Published in App Store Connect'));

  // 5. Review submission: reuse the one allowed draft, else create one.
  const draft = state.submissions.find((s) => s.state === 'READY_FOR_REVIEW');
  const subId = draft?.id ?? '$submission';
  if (!draft) {
    ops.push({ id: 'submission.create', desc: 'create review submission', method: 'post', path: '/v1/reviewSubmissions',
      body: { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: state.appId } } } } } });
  }
  const alreadyIn = draft?.items?.some((i) => i.appStoreVersion?.id === version.id);
  if (!alreadyIn) {
    ops.push({ id: 'submission.item', desc: `add ${version.versionString} to the submission`, method: 'post', path: '/v1/reviewSubmissionItems',
      body: { data: { type: 'reviewSubmissionItems', relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: subId } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } } } } });
  }
  ops.push({ id: 'submission.submit', desc: `submit ${version.versionString} (${build.version}) for review`, method: 'patch', path: `/v1/reviewSubmissions/${subId}`,
    body: { data: { type: 'reviewSubmissions', id: subId, attributes: { submitted: true } } } });

  return { ops, checks, version, build, ok: !checks.some((c) => c.status === 'fail') };
}

export function planCancel(state) {
  const open = state.submissions.filter((s) => ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES'].includes(s.state));
  if (!open.length) throw new Error('no submission in review to cancel');
  return open.map((s) => ({ id: 'submission.cancel', desc: `cancel submission ${s.id} (${s.state.replaceAll('_', ' ').toLowerCase()})`, method: 'patch',
    path: `/v1/reviewSubmissions/${s.id}`, body: { data: { type: 'reviewSubmissions', id: s.id, attributes: { canceled: true } } } }));
}

// Run ops in order, substituting ids created by earlier ops ($version, $submission).
export async function applyOps(api, ops, { log = () => {} } = {}) {
  const ids = {};
  const sub = (v) => JSON.parse(JSON.stringify(v).replace(/"\$(version|submission)"/g, (_, k) => JSON.stringify(ids[k])).replace(/\$(version|submission)/g, (_, k) => ids[k]));
  for (const op of ops) {
    const res = await api[op.method](sub(op.path), sub(op.body));
    if (op.id === 'version.create') ids.version = res.data.id;
    if (op.id === 'submission.create') ids.submission = res.data.id;
    log(`✓ ${op.desc}`);
  }
  return ids;
}
