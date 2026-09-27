// `ascship status`: where an app stands on App Store Connect, and whether
// anything is stuck. fetchStatus does the I/O; deriveStatus is pure.
import { hydrate } from './asc.js';
import { summarize } from './render.js';

const check = (status, id, message, extra = {}) => ({ status, id, message, ...extra });

export async function fetchStatus(api, appId) {
  const [app, versions, submissions, builds] = await Promise.all([
    api.get(`/v1/apps/${appId}?fields[apps]=name,bundleId`),
    api.get(`/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=10`
      + '&fields[appStoreVersions]=versionString,appVersionState,appStoreState,createdDate,build'
      + '&include=build&fields[builds]=version,processingState,uploadedDate'),
    api.get(`/v1/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&limit=10`
      + '&fields[reviewSubmissions]=state,submittedDate,appStoreVersionForReview'
      + '&include=appStoreVersionForReview&fields[appStoreVersions]=versionString'),
    api.get(`/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=5`
      + '&fields[builds]=version,processingState,uploadedDate,expired,preReleaseVersion'
      + '&include=preReleaseVersion&fields[preReleaseVersions]=version'),
  ]);
  return { app: hydrate(app), versions: hydrate(versions), submissions: hydrate(submissions), builds: hydrate(builds) };
}

const LIVE = 'READY_FOR_DISTRIBUTION';
const DONE = new Set([LIVE, 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE']);

const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ago = (iso, now) => {
  const d = Math.floor((now - new Date(iso)) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
};
const vb = (v) => `${v.versionString}${v.build?.version ? ` (${v.build.version})` : ''}`;
const state = (v) => v.appVersionState ?? v.appStoreState;

function versionChecks(versions, now) {
  const out = [];
  const sorted = [...versions].sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
  const live = sorted.find((v) => state(v) === LIVE);
  const next = sorted.find((v) => !DONE.has(state(v)) && (!live || new Date(v.createdDate) > new Date(live.createdDate)));

  out.push(live
    ? check('pass', 'version.live', `live: ${vb(live)}`)
    : check('info', 'version.none-live', 'no version is live yet'));
  if (!next) {
    out.push(check('info', 'version.none-pending', 'no new version in progress'));
    return { checks: out, next };
  }

  const s = state(next);
  const since = `created ${day(next.createdDate)}`;
  switch (s) {
    case 'PREPARE_FOR_SUBMISSION':
      out.push(check('info', 'version.preparing', `${next.versionString} is being prepared (${since})`));
      if (!next.build) {
        out.push(check('warn', 'version.no-build', `${next.versionString} has no build attached`, { hint: 'Attach a processed build before submitting.' }));
      } else if (next.build.processingState !== 'VALID') {
        out.push(check('warn', 'version.build-processing', `attached build ${next.build.version} is ${next.build.processingState}`));
      }
      out.push(check('info', 'version.app-privacy', 'App Privacy is not visible to the API: confirm it says Published (not just saved) in App Store Connect'));
      break;
    case 'READY_FOR_REVIEW':
    case 'WAITING_FOR_REVIEW':
    case 'IN_REVIEW':
      out.push(check('pass', 'version.in-review', `${vb(next)} is ${s.replaceAll('_', ' ').toLowerCase()}`));
      break;
    case 'PENDING_DEVELOPER_RELEASE':
      out.push(check('warn', 'version.awaiting-release', `${vb(next)} is approved and waiting for you to release it`));
      break;
    case 'PENDING_APPLE_RELEASE':
    case 'PROCESSING_FOR_DISTRIBUTION':
    case 'ACCEPTED':
      out.push(check('pass', 'version.releasing', `${vb(next)} is approved (${s.replaceAll('_', ' ').toLowerCase()})`));
      break;
    case 'WAITING_FOR_EXPORT_COMPLIANCE':
      out.push(check('fail', 'version.export-compliance', `${vb(next)} is blocked on export compliance`, {
        hint: 'Answer the encryption question for the build (usesNonExemptEncryption), or set ITSAppUsesNonExemptEncryption in Info.plist.',
      }));
      break;
    case 'REJECTED':
    case 'METADATA_REJECTED':
    case 'INVALID_BINARY':
      out.push(check('fail', 'version.rejected', `${vb(next)} was ${s === 'INVALID_BINARY' ? 'marked invalid binary' : s === 'METADATA_REJECTED' ? 'rejected for metadata' : 'rejected'}`, {
        hint: 'Read the message in App Store Connect → App Review. Metadata-only and backend fixes do not need a new build.',
      }));
      break;
    case 'DEVELOPER_REJECTED':
      out.push(check('info', 'version.pulled', `${vb(next)} was removed from review by you; ready to resubmit`));
      break;
    default:
      out.push(check('info', 'version.state', `${vb(next)} is ${s}`));
  }
  return { checks: out, next };
}

function submissionChecks(submissions, now) {
  const out = [];
  const open = submissions.filter((s) => s.state !== 'COMPLETE');
  for (const s of open) {
    const v = s.appStoreVersionForReview?.versionString;
    const what = v ? `submission for ${v}` : 'a submission';
    const when = s.submittedDate ? `submitted ${day(s.submittedDate)}, ${ago(s.submittedDate, now)}` : 'never submitted';
    switch (s.state) {
      case 'UNRESOLVED_ISSUES':
        out.push(check('fail', 'review.unresolved', `${what} has unresolved issues (rejected, ${when})`, {
          submissionId: s.id,
          hint: `Reply in App Review, or if you fixed it without a new build, cancel it (PATCH /v1/reviewSubmissions/${s.id} {"canceled": true}) and resubmit the same build.`,
        }));
        break;
      case 'READY_FOR_REVIEW':
        out.push(check('warn', 'review.draft', `${what} was created but never submitted`, {
          submissionId: s.id,
          hint: 'Only one draft submission can exist per platform; creating another fails until this one is submitted or emptied.',
        }));
        break;
      case 'CANCELING': {
        const stuck = s.submittedDate && now - new Date(s.submittedDate) > 3600e3;
        out.push(check(stuck ? 'warn' : 'info', 'review.canceling', `${what} is canceling${stuck ? ' and may be stuck' : ''}`, { submissionId: s.id }));
        break;
      }
      case 'WAITING_FOR_REVIEW':
      case 'IN_REVIEW':
      case 'COMPLETING':
        out.push(check('pass', 'review.open', `${what} is ${s.state.replaceAll('_', ' ').toLowerCase()} (${when})`));
        break;
      default:
        out.push(check('info', 'review.state', `${what} is ${s.state}`));
    }
  }
  if (!open.length) out.push(check('pass', 'review.clear', 'no open review submissions'));
  return out;
}

function buildChecks(builds, next, now) {
  const out = [];
  for (const b of builds.slice(0, 3)) {
    const label = `build ${b.preReleaseVersion?.version ? `${b.preReleaseVersion.version} ` : ''}(${b.version}), uploaded ${day(b.uploadedDate)}`;
    if (b.processingState === 'FAILED' || b.processingState === 'INVALID') {
      out.push(check('fail', 'build.invalid', `${label} is ${b.processingState}`, { hint: 'Apple emails the reason; usually a signing, entitlement or Info.plist problem. Run `ascship doctor` on the IPA.' }));
    } else if (b.processingState === 'PROCESSING') {
      out.push(check('info', 'build.processing', `${label} is still processing (${ago(b.uploadedDate, now)})`));
    } else if (b.expired) {
      out.push(check('info', 'build.expired', `${label} has expired from TestFlight`));
    } else {
      out.push(check('pass', 'build.valid', `${label}`));
    }
  }
  if (!builds.length) out.push(check('info', 'build.none', 'no builds uploaded yet'));
  const newest = builds.find((b) => b.processingState === 'VALID');
  if (next?.build && newest && newest.id !== next.build.id && Number(newest.version) > Number(next.build.version)) {
    const preparing = state(next) === 'PREPARE_FOR_SUBMISSION';
    out.push(check('warn', 'build.newer-unattached',
      `newest build (${newest.version}) is not the one ${preparing ? 'attached to' : 'in review for'} ${next.versionString} (${next.build.version})`, {
        hint: preparing
          ? 'Attach the newer build before submitting, if it is the one you meant to ship.'
          : 'If the newer build has fixes you meant to ship, pull the version from review, attach it, and resubmit.',
      }));
  }
  return out;
}

export function deriveStatus(raw, { now = new Date() } = {}) {
  const v = versionChecks(raw.versions, now);
  const sections = [
    { kind: 'versions', name: 'App Store', checks: v.checks },
    { kind: 'review', name: 'Review', checks: submissionChecks(raw.submissions, now) },
    { kind: 'builds', name: 'Builds', checks: buildChecks(raw.builds, v.next, now) },
  ];
  return { app: { id: raw.app.id, name: raw.app.name, bundleId: raw.app.bundleId }, sections, ...summarize(sections) };
}
