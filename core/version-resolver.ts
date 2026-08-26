/**
 * Shared engine version resolver
 *
 * One resolution ladder for every engine, so a version string means the same
 * thing on every code path that touches it (create, start, binary download,
 * binary path, engines download):
 *
 *   1. Exact/known resolution through hostdb (`resolveVersion`), which covers
 *      supported majors, the major-minor keys hostdb chooses to enumerate, and
 *      full version tokens including prereleases.
 *   2. Prefix resolution against hostdb's list of available releases, matched
 *      on version-segment boundaries and resolved to the NEWEST match
 *      ('3.10' -> 3.10.5, '18' -> 18.6.0, '25.12.3' -> 25.12.3.21).
 *   3. null, leaving the caller's existing "unknown version" path intact.
 *
 * Engine-agnostic by construction: nothing here branches on an engine name,
 * and the ordering comes from `compareVersions`, the comparator the rest of
 * the codebase already uses for every version scheme spindb supports.
 *
 * Prereleases stay opt-in. Step 2 only considers prerelease builds when the
 * requested string itself names a channel (it contains a `-`), so '19' never
 * silently resolves to '19.0.0-beta.3' while '19.0.0-beta' still can.
 */

import { resolveVersion as hostdbResolveVersion, listVersions } from 'hostdb'
import { resolveVersionPrefix } from './version-utils'

/**
 * All full versions hostdb has for an engine, newest first.
 * Returns an empty list for engines hostdb does not know about.
 */
export function listAvailableVersions(
  engine: string,
  options: { includePrerelease?: boolean } = {},
): string[] {
  const { includePrerelease = false } = options
  try {
    return listVersions(engine, { format: 'full', includePrerelease })
  } catch {
    return []
  }
}

/**
 * Resolve a version request for an engine to a full version hostdb can
 * actually download, or null when nothing matches.
 *
 * @param engine - hostdb engine name (e.g. 'postgresql', 'influxdb')
 * @param version - user-supplied version: full, major, or any prefix
 */
export function resolveEngineVersion(
  engine: string,
  version: string,
): string | null {
  if (!version) return null

  try {
    const exact = hostdbResolveVersion(engine, version)
    if (exact) return exact
  } catch {
    // Unknown engine or malformed request: fall through to prefix matching,
    // which degrades to null on an empty candidate list.
  }

  const includePrerelease = version.includes('-')
  return resolveVersionPrefix(
    version,
    listAvailableVersions(engine, { includePrerelease }),
  )
}

/**
 * Human-readable list of the versions an engine actually has, for error
 * messages. Empty string when hostdb knows no versions for the engine, so
 * callers can append it unconditionally.
 */
export function formatAvailableVersions(engine: string): string {
  const versions = listAvailableVersions(engine)
  if (versions.length === 0) return ''
  return `Available versions: ${versions.join(', ')}. `
}

/**
 * The message every binary manager shows when a download 404s, including what
 * IS available so the user can correct the version without a second command.
 */
export function binariesNotFoundMessage(options: {
  engine: string
  displayName: string
  version: string
}): string {
  const { engine, displayName, version } = options
  return (
    `${displayName} ${version} binaries not found (404). ` +
    `This version may have been removed from hostdb, or may never have existed. ` +
    `${formatAvailableVersions(engine)}` +
    `Check https://registry.layerbase.host`
  )
}
