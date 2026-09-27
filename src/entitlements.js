// Pure entitlement checks. No I/O here, so everything is unit-testable.
//
// Two separate questions, deliberately never collapsed into one diff:
//   1. Does the release claim everything it needs?      (checkExpected: app vs ascship.yaml)
//   2. Does the profile allow everything the app claims? (checkAllowed:  app vs profile allowlist)
// A profile may authorize entitlements the app doesn't claim and may use wildcards,
// so an exact app-vs-profile diff gives both false alarms and false passes.
// See Apple TN3125 "Inside Code Signing: Provisioning Profiles".

// Keys every signed app carries; they aren't capabilities anyone opts into.
export const BOILERPLATE = new Set([
  'application-identifier',
  'com.apple.developer.team-identifier',
  'get-task-allow',
  'beta-reports-active',
]);

const PASS = 'pass', WARN = 'warn', FAIL = 'fail';
const check = (status, id, message, extra = {}) => ({ status, id, message, ...extra });

const fmt = (v) => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));

export function globMatch(pattern, value) {
  if (typeof pattern !== 'string') return pattern === value;
  if (!pattern.includes('*')) return pattern === value;
  if (typeof value !== 'string') return pattern === '*';
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(value);
}

// Is `claimed` (scalar or array) permitted by the profile's value for the same key?
export function isAllowed(claimed, allowed) {
  if (allowed === undefined) return false;
  const claims = Array.isArray(claimed) ? claimed : [claimed];
  const allows = Array.isArray(allowed) ? allowed : [allowed];
  return claims.every((c) => allows.some((a) => globMatch(a, c)));
}

// 1. The release claims everything ascship.yaml says it needs.
export function checkExpected(actual, expected, { profile } = {}) {
  const out = [];
  for (const [key, want] of Object.entries(expected)) {
    const have = actual[key];
    const inProfile = profile && profile[key] !== undefined;
    if (have === undefined) {
      const hint = inProfile
        ? 'The profile allows it but the app never claimed it, so it was dropped before signing (regenerated project? missing CODE_SIGN_ENTITLEMENTS?).'
        : 'The profile does not allow it either. Enable the capability on the App ID and regenerate the profile.';
      out.push(check(FAIL, 'expected.missing', `${key} missing (expected ${fmt(want)})`, { key, expected: want, actual: null, hint }));
      continue;
    }
    if (Array.isArray(want)) {
      const haveArr = Array.isArray(have) ? have : [have];
      const missing = want.filter((w) => !haveArr.includes(w));
      if (missing.length) {
        out.push(check(FAIL, 'expected.items', `${key} is missing ${fmt(missing)}`, { key, expected: want, actual: have }));
      } else {
        out.push(check(PASS, 'expected.ok', `${key} = ${fmt(have)}`, { key }));
      }
    } else if (have !== want) {
      out.push(check(FAIL, 'expected.value', `${key} = ${fmt(have)}, expected ${fmt(want)}`, { key, expected: want, actual: have }));
    } else {
      out.push(check(PASS, 'expected.ok', `${key} = ${fmt(have)}`, { key }));
    }
  }
  for (const key of Object.keys(actual)) {
    if (BOILERPLATE.has(key) || key in expected) continue;
    out.push(check(WARN, 'expected.unlisted', `${key} is claimed but not listed in ascship.yaml`, {
      key, actual: actual[key], hint: 'Add it to ascship.yaml if this release needs it, so a future build that drops it fails.',
    }));
  }
  return out;
}

// 2. The profile allows everything the app claims.
export function checkAllowed(actual, profile) {
  const out = [];
  const denied = Object.keys(actual).filter((k) => !isAllowed(actual[k], profile[k]));
  for (const key of denied) {
    const hint = profile[key] === undefined
      ? 'The profile has no such entitlement. Enable the capability on the App ID and regenerate the profile.'
      : `The profile only allows ${fmt(profile[key])}.`;
    out.push(check(FAIL, 'profile.denied', `${key} = ${fmt(actual[key])} is not allowed by the provisioning profile`, { key, hint }));
  }
  if (!denied.length) out.push(check(PASS, 'profile.ok', `profile allows all ${Object.keys(actual).length} claimed entitlements`));
  return out;
}

// Rules that hold for every app, no config needed.
export function checkBuiltins(actual, { distribution, teamId, bundleId }) {
  const out = [];
  const store = distribution === 'app-store' || distribution === 'ad-hoc' || distribution === 'enterprise';

  const appId = actual['application-identifier'];
  if (appId && teamId && bundleId && appId !== `${teamId}.${bundleId}`) {
    out.push(check(FAIL, 'builtin.app-id', `application-identifier ${appId} does not match ${teamId}.${bundleId}`));
  }
  if (store && actual['get-task-allow'] === true) {
    out.push(check(FAIL, 'builtin.get-task-allow', `get-task-allow is true in a ${distribution} build (debuggable; App Store rejects it)`));
  }
  const aps = actual['aps-environment'];
  if (aps !== undefined) {
    if (store && aps !== 'production') {
      out.push(check(FAIL, 'builtin.aps', `aps-environment = ${aps} in a ${distribution} build (must be production)`, {
        hint: 'Export with an App Store / ad-hoc profile; the export step promotes development to production.',
      }));
    } else if (distribution === 'development' && aps !== 'development') {
      out.push(check(WARN, 'builtin.aps', `aps-environment = ${aps} in a development build`));
    }
  }
  return out;
}

// Profile-level sanity (expiry, team) for one bundle.
export function checkProfile(profile, { now = new Date(), mainTeamId } = {}) {
  const out = [];
  if (!profile) return [check(FAIL, 'profile.missing', 'no embedded.mobileprovision')];
  const exp = profile.expirationDate ? new Date(profile.expirationDate) : null;
  const where = `profile "${profile.name}"`;
  if (exp && exp < now) {
    out.push(check(FAIL, 'profile.expired', `${where} expired ${exp.toISOString().slice(0, 10)}`));
  } else if (exp && exp - now < 30 * 864e5) {
    out.push(check(WARN, 'profile.expiring', `${where} expires ${exp.toISOString().slice(0, 10)}`));
  } else {
    out.push(check(PASS, 'profile.valid', `${where} · team ${profile.teamId}${exp ? ` · expires ${exp.toISOString().slice(0, 10)}` : ''}`));
  }
  if (mainTeamId && profile.teamId && profile.teamId !== mainTeamId) {
    out.push(check(FAIL, 'profile.team', `team ${profile.teamId} differs from the main app's team ${mainTeamId}`));
  }
  return out;
}

// Build an ascship.yaml expectation block from a known-good build.
export function snapshot(actual) {
  return Object.fromEntries(Object.entries(actual).filter(([k]) => !BOILERPLATE.has(k)));
}
