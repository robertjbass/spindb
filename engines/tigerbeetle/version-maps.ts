/**
 * TigerBeetle Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 *
 * SUPPORTED_MAJOR_VERSIONS is 2-part (e.g., '0.16') to preserve the existing
 * spindb convention. The 1-part key '0' still resolves via the MAP.
 */

import {
  resolveVersion as hostdbResolveVersion,
  listVersions,
} from 'hostdb'
import { buildVersionMap } from '../version-map-builder'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'tigerbeetle'

export const TIGERBEETLE_VERSION_MAP: Record<string, string> = buildVersionMap(ENGINE)

export const SUPPORTED_MAJOR_VERSIONS = listVersions(ENGINE, {
  format: 'major-minor',
})

export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `TigerBeetle version '${version}' not in hostdb, may not be available for download`,
  )
  return version
}
