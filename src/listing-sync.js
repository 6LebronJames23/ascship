// `ascship listing pull|push`: the store listing as text in ascship.yaml.
// Name, subtitle and privacy URL live on the app info (app-level); everything
// else lives on the app store version. Mixing them up is a 409.
import { hydrate } from './asc.js';
import { checkLocale } from './listing.js';

export const APP_FIELDS = ['name', 'subtitle', 'privacyPolicyUrl'];
export const VERSION_FIELDS = ['description', 'keywords', 'promotionalText', 'whatsNew', 'supportUrl', 'marketingUrl'];

const LIVE_INFO = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION']);
const EDITABLE_VERSION = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);
const vstate = (v) => v.appVersionState ?? v.appStoreState;
const istate = (i) => i.state ?? i.appStoreState;

export async function fetchListing(api, appId) {
  const [infos, versions] = await Promise.all([
    api.get(`/v1/apps/${appId}/appInfos?include=appInfoLocalizations&limit=10&limit[appInfoLocalizations]=50`),
    api.get(`/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=10&include=appStoreVersionLocalizations&limit[appStoreVersionLocalizations]=50`
      + '&fields[appStoreVersions]=versionString,appVersionState,appStoreState,createdDate,appStoreVersionLocalizations'),
  ]);
  const infoList = hydrate(infos), versionList = hydrate(versions);
  const byLocale = (locs) => Object.fromEntries((locs ?? []).map((l) => [l.locale, l]));
  const liveVersion = versionList.find((v) => vstate(v) === 'READY_FOR_DISTRIBUTION');
  // Editable = the draft app info / version, never the live one (Apple locks those).
  const info = infoList.find((i) => !LIVE_INFO.has(istate(i))) ?? null;
  const version = versionList.find((v) => EDITABLE_VERSION.has(vstate(v))) ?? null;
  // What people see now, for pull: live records first.
  const shownInfo = infoList.find((i) => LIVE_INFO.has(istate(i))) ?? infoList[0];
  const shownVersion = version ?? liveVersion ?? versionList[0];
  return {
    info: info && { id: info.id, locales: byLocale(info.appInfoLocalizations) },
    version: version && { id: version.id, versionString: version.versionString, locales: byLocale(version.appStoreVersionLocalizations) },
    firstRelease: !liveVersion,
    shown: {
      info: shownInfo && byLocale(shownInfo.appInfoLocalizations),
      version: shownVersion && byLocale(shownVersion.appStoreVersionLocalizations),
      versionString: shownVersion?.versionString,
    },
  };
}

export function toYaml(remote) {
  const locales = new Set([...Object.keys(remote.shown.info ?? {}), ...Object.keys(remote.shown.version ?? {})]);
  const out = {};
  for (const loc of [...locales].sort()) {
    const fields = {};
    for (const f of APP_FIELDS) if (remote.shown.info?.[loc]?.[f]) fields[f] = remote.shown.info[loc][f];
    for (const f of VERSION_FIELDS) if (remote.shown.version?.[loc]?.[f]) fields[f] = remote.shown.version[loc][f];
    out[loc] = fields;
  }
  return out;
}

// Pure: what push would change. Returns ops and anything it can't do.
export function diffListing(local, remote) {
  const ops = [], blocked = [], notes = [];
  for (const [locale, fields] of Object.entries(local ?? {})) {
    for (const [scope, keys, target, label] of [
      ['info', APP_FIELDS, remote.info, 'app info'],
      ['version', VERSION_FIELDS, remote.version, `version ${remote.version?.versionString ?? ''}`.trim()],
    ]) {
      const wanted = Object.fromEntries(keys.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]]));
      if (scope === 'version' && remote.firstRelease && 'whatsNew' in wanted) {
        delete wanted.whatsNew;
        notes.push(`${locale}.whatsNew skipped: not allowed on an app's first release`);
      }
      if (!Object.keys(wanted).length) continue;
      if (!target) {
        // Nothing editable: only complain about fields that differ from what is live.
        const live = remote.shown?.[scope]?.[locale] ?? {};
        const changed = Object.keys(wanted).filter((k) => (live[k] ?? '') !== wanted[k]);
        if (!changed.length) continue;
        blocked.push(scope === 'info'
          ? `${locale}: ${changed.join(', ')} can't change while there is no editable app info (it unlocks when you create a new version)`
          : `${locale}: ${changed.join(', ')} need a version in progress. Create one with \`ascship submit --app-version <x.y>\` first, or in App Store Connect`);
        continue;
      }
      const existing = target.locales[locale];
      const changes = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => (existing?.[k] ?? '') !== v));
      if (!Object.keys(changes).length) continue;
      ops.push({
        scope, locale, label, create: !existing, id: existing?.id, parentId: target.id,
        changes, before: Object.fromEntries(Object.keys(changes).map((k) => [k, existing?.[k] ?? null])),
      });
    }
  }
  return { ops, blocked, notes };
}

export async function applyListing(api, ops) {
  for (const op of ops) {
    const type = op.scope === 'info' ? 'appInfoLocalizations' : 'appStoreVersionLocalizations';
    if (op.create) {
      const parent = op.scope === 'info' ? { appInfo: { data: { type: 'appInfos', id: op.parentId } } }
        : { appStoreVersion: { data: { type: 'appStoreVersions', id: op.parentId } } };
      await api.post(`/v1/${type}`, { data: { type, attributes: { locale: op.locale, ...op.changes }, relationships: parent } });
    } else {
      await api.patch(`/v1/${type}/${op.id}`, { data: { type, id: op.id, attributes: op.changes } });
    }
  }
}

export function preflight(local) {
  return Object.entries(local ?? {}).flatMap(([locale, fields]) => checkLocale(locale, fields));
}
