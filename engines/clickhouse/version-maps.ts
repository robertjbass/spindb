/**
 * ClickHouse Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 *
 * ClickHouse uses YY.MM.X.build versioning (e.g., 25.12.3.21). The YY.MM form
 * is the major-minor key used everywhere in spindb. SUPPORTED_MAJOR_VERSIONS
 * is 2-part to preserve that convention; '25' still resolves via the MAP.
 */

import { resolveVersion as hostdbResolveVersion, listVersions } from 'hostdb'
import { buildVersionMap as buildBaseVersionMap } from '../version-map-builder'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'clickhouse'

function buildVersionMap(): Record<string, string> {
  const map = buildBaseVersionMap(ENGINE)
  // ClickHouse 4-part full versions have a 3-part prefix (e.g., 25.12.3) that
  // should also resolve. Add 3-part prefix to the MAP for spindb's existing
  // identity-match call paths.
  for (const full of listVersions(ENGINE, {
    format: 'full',
    includePrerelease: true,
  })) {
    const parts = full.split('.')
    if (parts.length === 4) {
      const threePartPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`
      const r = hostdbResolveVersion(ENGINE, threePartPrefix)
      if (r) map[threePartPrefix] = r
    }
  }
  return map
}

export const CLICKHOUSE_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = listVersions(ENGINE, {
  format: 'major-minor',
})

export function getFullVersion(version: string): string | null {
  return hostdbResolveVersion(ENGINE, version)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved

  const parts = version.split('.')
  const isValidFormat =
    parts.length >= 2 &&
    parts.length <= 4 &&
    parts.every((p) => /^\d+$/.test(p))

  if (!isValidFormat) {
    logDebug(
      `ClickHouse version '${version}' has invalid format, may not be available in hostdb`,
    )
  } else {
    logDebug(
      `ClickHouse version '${version}' not in hostdb, may not be available for download`,
    )
  }
  return version
}

export function getMajorVersion(version: string): string {
  const parts = version.split('.')
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`
  }
  return version
}
