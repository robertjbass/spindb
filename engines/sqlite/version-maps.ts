/**
 * SQLite Version Maps
 *
 * Thin wrapper around the `hostdb` npm package — hostdb is the single source
 * of truth for which versions exist and how short version strings resolve.
 *
 * To bump versions: update hostdb's databases.yml + sources.json, publish a
 * new hostdb to npm, then bump this package's `hostdb` dependency.
 *
 * The exports below preserve the legacy shape so call sites don't change.
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'sqlite'

function buildVersionMap(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const major of getSupportedMajorVersions(ENGINE)) {
    const r = hostdbResolveVersion(ENGINE, major)
    if (r) map[major] = r
  }
  for (const minor of listVersions(ENGINE, { format: 'major-minor' })) {
    const r = hostdbResolveVersion(ENGINE, minor)
    if (r) map[minor] = r
  }
  for (const full of listVersions(ENGINE, {
    format: 'full',
    includePrerelease: true,
  })) {
    map[full] = full
  }
  return map
}

export const SQLITE_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `SQLite version '${version}' not in hostdb, may not be available for download`,
  )
  return version
}
