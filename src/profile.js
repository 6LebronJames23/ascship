// `ascship profile`: make sure every bundle in the app has a usable provisioning
// profile signed by a certificate whose private key is on this Mac, and install it.
// Never deletes profiles: reuses a matching one or creates a new, uniquely named one.
import { hydrate } from './asc.js';
import { localIdentities, normSerial, PROFILE_TYPES, installProfile } from './signing.js';

const DAY = 864e5;
const q = (ids) => ids.map(encodeURIComponent).join(',');

export function teamFromIdentity(name) {
  return /\(([A-Z0-9]{10})\)\s*$/.exec(name ?? '')?.[1];
}

// Pure: decide what to do for each bundle id.
export function planProfiles({ type, bundleIds, certs, identities, bundles, profiles, devices, now = new Date() }) {
  const spec = PROFILE_TYPES[type];
  if (!spec) throw new Error(`--type must be one of ${Object.keys(PROFILE_TYPES).join(', ')}`);
  const local = identities.filter((i) => i.kind === spec.certKind && i.serial);
  const cert = certs.find((c) => spec.certTypes.includes(c.certificateType)
    && new Date(c.expirationDate) > now && local.some((i) => i.serial === normSerial(c.serialNumber)));
  if (!cert) {
    const onAccount = certs.filter((c) => spec.certTypes.includes(c.certificateType)).length;
    throw new Error(onAccount
      ? `none of the account's ${spec.certKind} certificates has its private key in this Mac's keychain. Import the .p12, or create a new certificate in Xcode or App Store Connect.`
      : `the account has no ${spec.certKind} certificate. Create one in App Store Connect → Certificates, Identifiers & Profiles.`);
  }
  const identity = local.find((i) => i.serial === normSerial(cert.serialNumber));
  const enabledDevices = spec.devices ? devices.filter((d) => d.status === 'ENABLED') : [];
  if (spec.devices && !enabledDevices.length) throw new Error(`${type} profiles need at least one registered device`);

  const items = bundleIds.map((bundleId) => {
    const record = bundles.find((b) => b.identifier === bundleId);
    const reusable = profiles
      .filter((p) => p.profileType === spec.api && p.profileState === 'ACTIVE' && p.bundleId?.identifier === bundleId)
      .filter((p) => p.certificates?.some((c) => c.id === cert.id))
      .filter((p) => new Date(p.expirationDate) - now > 30 * DAY)
      .filter((p) => !spec.devices || enabledDevices.every((d) => p.devices?.some((x) => x.id === d.id)))
      .sort((a, b) => new Date(b.expirationDate) - new Date(a.expirationDate))[0];
    if (reusable) return { bundleId, action: 'reuse', profile: reusable };
    return {
      bundleId,
      action: 'create',
      registerBundle: !record,
      bundleRecordId: record?.id,
      name: `${bundleId} ${type} ${now.toISOString().slice(0, 10)} ascship`,
    };
  });
  return { type, spec, cert, identity, teamId: teamFromIdentity(identity?.name), devices: enabledDevices, items };
}

export async function fetchSigningState(api, type, bundleIds) {
  const spec = PROFILE_TYPES[type];
  if (!spec) throw new Error(`--type must be one of ${Object.keys(PROFILE_TYPES).join(', ')}`);
  const [certs, bundles, profiles, devices] = await Promise.all([
    api.get('/v1/certificates?limit=200&fields[certificates]=certificateType,name,serialNumber,expirationDate'),
    api.get(`/v1/bundleIds?filter[identifier]=${q(bundleIds)}&limit=200&fields[bundleIds]=identifier,name,platform`),
    api.get(`/v1/profiles?filter[profileType]=${spec.api}&limit=200&include=bundleId,certificates${spec.devices ? ',devices' : ''}`
      + '&fields[profiles]=name,profileState,profileType,expirationDate,uuid,profileContent,bundleId,certificates,devices'
      + '&fields[bundleIds]=identifier&fields[certificates]=serialNumber'),
    spec.devices ? api.get('/v1/devices?filter[platform]=IOS&limit=200&fields[devices]=name,udid,status') : { data: [] },
  ]);
  return {
    certs: hydrate(certs), bundles: hydrate(bundles), profiles: hydrate(profiles), devices: hydrate(devices),
    identities: localIdentities(),
  };
}

// Carry out a plan. Returns { bundleId: profileName } for export options.
export async function applyPlan(api, plan, { install = true, log = () => {} } = {}) {
  const mapping = {};
  for (const item of plan.items) {
    let profile = item.profile;
    if (item.action === 'create') {
      let bundleRecordId = item.bundleRecordId;
      if (item.registerBundle) {
        const res = await api.post('/v1/bundleIds', { data: { type: 'bundleIds', attributes: {
          identifier: item.bundleId, name: item.bundleId.replace(/[^A-Za-z0-9 ]/g, ' '), platform: 'IOS',
        } } });
        bundleRecordId = res.data.id;
        log(`registered bundle id ${item.bundleId}`);
      }
      const res = await api.post('/v1/profiles', { data: {
        type: 'profiles',
        attributes: { name: item.name, profileType: plan.spec.api },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundleRecordId } },
          certificates: { data: [{ type: 'certificates', id: plan.cert.id }] },
          ...(plan.spec.devices ? { devices: { data: plan.devices.map((d) => ({ type: 'devices', id: d.id })) } } : {}),
        },
      } });
      profile = { id: res.data.id, ...res.data.attributes };
      log(`created profile "${profile.name}"`);
    }
    if (install && profile.profileContent) installProfile(profile.uuid, profile.profileContent);
    mapping[item.bundleId] = profile.name;
  }
  return mapping;
}
