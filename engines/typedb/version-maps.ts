/**
 * TypeDB Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'typedb'

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
  for (const full of listVersions(ENGINE, { format: 'full' })) {
    map[full] = full
  }
  return map
}

export const TYPEDB_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const DEFAULT_VERSION = SUPPORTED_MAJOR_VERSIONS[0] ?? '3'

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `TypeDB version "${version}" not in hostdb (available majors: ${SUPPORTED_MAJOR_VERSIONS.join(', ')}), using as-is`,
  )
  return version
}

export function isVersionSupported(version: string): boolean {
  return Object.hasOwn(TYPEDB_VERSION_MAP, version)
}

export function getLatestPatch(majorVersion: string): string | undefined {
  return TYPEDB_VERSION_MAP[majorVersion]
}
