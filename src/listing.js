// Store listing text checks, run against the `listing:` block in ascship.yaml
// before anything is sent to App Store Connect.

const check = (status, id, message, extra = {}) => ({ status, id, message, ...extra });

// App Store Connect field limits (characters).
export const LIMITS = { name: 30, subtitle: 30, keywords: 100, promotionalText: 170, description: 4000, whatsNew: 4000 };
export const URL_FIELDS = new Set(['privacyPolicyUrl', 'supportUrl', 'marketingUrl']);

// Fields where emoji have been rejected outright by the API; elsewhere they are a warning.
const EMOJI_REJECTED = new Set(['description', 'whatsNew']);
// Characters that render as emoji: emoji-presentation code points, or symbols forced
// to emoji with U+FE0F. Plain text symbols (© ™ ✓ →) are left alone.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\u20E3/u;

const len = (s) => [...s].length;
const words = (s) => (s ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function checkLocale(locale, fields) {
  const out = [];
  for (const [field, value] of Object.entries(fields ?? {})) {
    if (URL_FIELDS.has(field)) {
      let ok = false;
      try { ok = new URL(value).protocol === 'https:'; } catch {}
      if (!ok) out.push(check('fail', 'listing.url', `${locale}.${field} is not an https URL: ${value}`, { field }));
      continue;
    }
    if (!(field in LIMITS)) {
      out.push(check('warn', 'listing.unknown-field', `${locale}.${field} is not a listing field ascship knows (${[...Object.keys(LIMITS), ...URL_FIELDS].join(', ')})`));
      continue;
    }
    if (typeof value !== 'string') continue;
    const n = len(value);
    if (n > LIMITS[field]) {
      out.push(check('fail', 'listing.too-long', `${locale}.${field} is ${n} characters (limit ${LIMITS[field]})`, { field }));
    }
    const emoji = value.match(EMOJI);
    if (emoji) {
      out.push(EMOJI_REJECTED.has(field)
        ? check('fail', 'listing.emoji', `${locale}.${field} contains emoji (${emoji[0]}); App Store Connect rejects it`, { field })
        : check('warn', 'listing.emoji', `${locale}.${field} contains emoji (${emoji[0]}); App Review may reject it`, { field }));
    }
    if (value !== value.trim()) {
      out.push(check('warn', 'listing.whitespace', `${locale}.${field} has leading or trailing whitespace`, { field }));
    }
  }

  const kw = fields?.keywords;
  if (typeof kw === 'string' && kw.length) {
    const terms = kw.split(',').map((t) => t.trim()).filter(Boolean);
    const seen = new Set(), dupes = new Set();
    for (const t of terms.map((t) => t.toLowerCase())) (seen.has(t) ? dupes : seen).add(t);
    if (dupes.size) out.push(check('warn', 'listing.keyword-dupes', `${locale}.keywords repeats ${[...dupes].join(', ')}`));
    const indexed = new Set([...words(fields.name), ...words(fields.subtitle)]);
    const wasted = [...new Set(terms.flatMap(words))].filter((w) => indexed.has(w));
    if (wasted.length) {
      out.push(check('warn', 'listing.keyword-in-name', `${locale}.keywords repeats ${wasted.join(', ')} from the name or subtitle`, {
        hint: 'The name and subtitle are already indexed for search, so these keyword characters are wasted.',
      }));
    }
    if (/,\s/.test(kw)) {
      const spare = (kw.match(/,\s+/g) ?? []).reduce((a, s) => a + s.length - 1, 0);
      out.push(check('warn', 'listing.keyword-spaces', `${locale}.keywords has spaces after commas (${spare} character${spare === 1 ? '' : 's'} that could be keywords)`));
    }
  }
  return out;
}

export function checkListing(listing) {
  const sections = [];
  for (const [locale, fields] of Object.entries(listing ?? {})) {
    const checks = checkLocale(locale, fields);
    const present = Object.keys(fields ?? {}).filter((f) => f in LIMITS || URL_FIELDS.has(f));
    if (!checks.some((c) => c.status === 'fail')) {
      checks.unshift(check('pass', 'listing.ok', `${present.length} field${present.length === 1 ? '' : 's'} within limits${checks.length ? '' : ', no emoji'}`));
    }
    sections.push({ kind: 'listing', name: `Listing ${locale}`, checks });
  }
  return sections;
}
