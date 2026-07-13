/**
 * SurrealDB Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'

const ENGINE = 'surrealdb'

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

export const SURREALDB_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const DEFAULT_VERSION = SUPPORTED_MAJOR_VERSIONS[0] ?? '2'

export function normalizeVersion(version: string): string {
  return hostdbResolveVersion(ENGINE, version) ?? version
}

export function isVersionSupported(version: string): boolean {
  return version in SURREALDB_VERSION_MAP
}

export function getLatestPatch(majorVersion: string): string | undefined {
  return SURREALDB_VERSION_MAP[majorVersion]
}
