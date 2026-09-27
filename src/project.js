// What the local project looks like: targets, bundle ids, scheme, project file.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import YAML from 'yaml';
import { findProject } from './versions.js';

const SHIPPABLE = /^(application|app-extension|application\.watchapp2|watchkit2-extension|extensionkit-extension|application\.on-demand-install-capable)/;

function setting(target, spec, key) {
  for (const s of [target.settings, spec.settings]) {
    if (!s) continue;
    if (s.base?.[key] !== undefined) return String(s.base[key]);
    if (s[key] !== undefined && typeof s[key] !== 'object') return String(s[key]);
  }
  return undefined;
}

// Targets that end up in the IPA, with their bundle ids, as xcodegen resolves them.
export function readTargets(ymlPath) {
  const spec = YAML.parse(readFileSync(ymlPath, 'utf8')) ?? {};
  const prefix = spec.options?.bundleIdPrefix;
  return Object.entries(spec.targets ?? {})
    .filter(([, t]) => SHIPPABLE.test(t.type ?? ''))
    .map(([name, t]) => ({
      name,
      type: t.type,
      bundleId: setting(t, spec, 'PRODUCT_BUNDLE_IDENTIFIER') ?? (prefix ? `${prefix}.${name}` : undefined),
    }))
    .filter((t) => t.bundleId && !t.bundleId.includes('$('));
}

export function describeProject(arg) {
  const found = findProject(arg ?? '.');
  if (!found) return null;
  const out = { dir: found.dir, yml: found.yml, xcodeproj: found.xcodeproj };
  const ws = readdirSync(found.dir).find((f) => f.endsWith('.xcworkspace'));
  if (ws) out.workspace = join(found.dir, ws);
  if (found.yml) {
    out.targets = readTargets(found.yml);
    out.name = YAML.parse(readFileSync(found.yml, 'utf8'))?.name;
  }
  const app = out.targets?.find((t) => t.type.startsWith('application') && !t.type.includes('watch'));
  out.scheme = app?.name ?? (found.xcodeproj ? basename(found.xcodeproj, '.xcodeproj') : undefined);
  return out;
}

export function bundleIdsFor(project, config) {
  if (project?.targets?.length) return project.targets.map((t) => t.bundleId);
  if (config.app?.bundleId) return [config.app.bundleId];
  return [];
}
