/**
 * Shared version-map builder for the per-engine `hostdb` wrappers.
 *
 * Every engine's version-maps module builds an identical MAP from hostdb: bare
 * majors, major-minor keys (for engines that expose them), and full versions
 * (including prereleases) mapped to themselves. Centralizing it here keeps the
 * 20+ wrappers in sync when the shape changes (e.g., the prerelease rollout).
 *
 * Engines with extra keys (ClickHouse adds 3-part prefixes for its 4-part
 * versions) call this and then augment the returned map.
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'

export function buildVersionMap(engine: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const major of getSupportedMajorVersions(engine)) {
    const r = hostdbResolveVersion(engine, major)
    if (r) map[major] = r
  }
  for (const minor of listVersions(engine, { format: 'major-minor' })) {
    const r = hostdbResolveVersion(engine, minor)
    if (r) map[minor] = r
  }
  for (const full of listVersions(engine, {
    format: 'full',
    includePrerelease: true,
  })) {
    map[full] = full
  }
  return map
}
