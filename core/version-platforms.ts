/**
 * Version-level platform support from hostdb's bundled databases.json.
 *
 * Most hostdb versions are built for every platform the engine supports, but a
 * version entry can narrow that with its own `platforms` list (for example the
 * Linux x64 only `18.6.0-cron.1` PostgreSQL build revision). Building a
 * download URL for a platform outside that list produces a guaranteed 404, so
 * these helpers let the version picker hide such versions and let the download
 * path fail early with an actionable message.
 *
 * Only an explicit version-level list is enforced. A version with no list, a
 * version this hostdb snapshot does not know, or an unknown engine is treated
 * as available everywhere, so existing downloads never start failing here.
 * Platforms in `retiredPlatforms` still have an artifact on the registry and
 * stay downloadable.
 */

import { getDatabaseEntry } from 'hostdb'
import { BinaryVersionNotFoundError } from './version-resolver'

/**
 * The platforms a version is explicitly built for, or null when the version
 * entry does not narrow the engine's platforms (or is unknown).
 */
export function getVersionPlatformList(
  engine: string,
  version: string,
): string[] | null {
  let entry: ReturnType<typeof getDatabaseEntry>
  try {
    entry = getDatabaseEntry(engine)
  } catch {
    return null
  }
  const value = entry?.versions?.[version]
  if (!value || typeof value !== 'object') return null
  const platforms = value.platforms
  if (!platforms) return null
  const list = Array.isArray(platforms) ? platforms : Object.keys(platforms)
  return list.length > 0 ? [...list] : null
}

function getRetiredPlatformList(engine: string, version: string): string[] {
  try {
    const value = getDatabaseEntry(engine)?.versions?.[version]
    if (!value || typeof value !== 'object') return []
    return Object.keys(value.retiredPlatforms ?? {})
  } catch {
    return []
  }
}

/**
 * Whether hostdb has (or may have) an artifact for this version on this
 * platform. `platformKey` uses hostdb naming, e.g. `darwin-arm64`.
 */
export function isVersionBuiltForPlatform(
  engine: string,
  version: string,
  platformKey: string,
): boolean {
  const platforms = getVersionPlatformList(engine, version)
  if (!platforms) return true
  return (
    platforms.includes(platformKey) ||
    getRetiredPlatformList(engine, version).includes(platformKey)
  )
}

/**
 * Throw an actionable error when a version is not built for the platform.
 */
export function assertVersionBuiltForPlatform(
  engine: string,
  options: { version: string; platformKey: string },
): void {
  const { version, platformKey } = options
  if (isVersionBuiltForPlatform(engine, version, platformKey)) return
  const platforms = getVersionPlatformList(engine, version) ?? []
  throw new BinaryVersionNotFoundError(
    `${engine} ${version} is not built for ${platformKey} (built for: ${platforms.join(', ')}). ` +
      `Pick a different version: the interactive \`spindb create\` picker lists only versions built for this platform, ` +
      `or pass a major version such as \`--db-version ${version.split('.')[0]}\` to get the default build. ` +
      `To use ${version}, run spindb on ${platforms.join(' or ')}.`,
  )
}

/**
 * Drop versions that are not built for this platform from a picker list.
 */
export function filterVersionsForPlatform(
  engine: string,
  versions: string[],
  platformKey: string,
): string[] {
  return versions.filter((version) =>
    isVersionBuiltForPlatform(engine, version, platformKey),
  )
}

/**
 * Filter a major -> versions map (the picker's shape) for this platform.
 * `hiddenMajors` holds majors that had versions but have none left, so the
 * picker can drop the whole line instead of offering an empty one.
 */
export function filterVersionMapForPlatform(
  engine: string,
  versionsByMajor: Record<string, string[]>,
  platformKey: string,
): { versions: Record<string, string[]>; hiddenMajors: Set<string> } {
  const versions: Record<string, string[]> = {}
  const hiddenMajors = new Set<string>()
  for (const [major, list] of Object.entries(versionsByMajor)) {
    const kept = filterVersionsForPlatform(engine, list, platformKey)
    if (list.length > 0 && kept.length === 0) {
      hiddenMajors.add(major)
      continue
    }
    versions[major] = kept
  }
  return { versions, hiddenMajors }
}
