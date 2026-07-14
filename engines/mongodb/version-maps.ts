/**
 * MongoDB Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 *
 * Note: SUPPORTED_MAJOR_VERSIONS is 2-part (e.g., '8.0') to preserve the
 * convention used by `core/version-migration.ts:getMajorVersion()`. 1-part
 * keys '7' and '8' still resolve via the MAP (LTS-pick: '8' → 8.0.23, not 8.2.9).
 */

import {
  resolveVersion as hostdbResolveVersion,
  listVersions,
} from 'hostdb'
import { buildVersionMap } from '../version-map-builder'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'mongodb'

export const MONGODB_VERSION_MAP: Record<string, string> = buildVersionMap(ENGINE)

export const SUPPORTED_MAJOR_VERSIONS = listVersions(ENGINE, {
  format: 'major-minor',
})

export const FALLBACK_VERSION_MAP: Record<string, string> = MONGODB_VERSION_MAP

export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `MongoDB version '${version}' not in hostdb, may not be available for download`,
  )
  return version
}
