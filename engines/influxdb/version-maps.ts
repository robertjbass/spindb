/**
 * InfluxDB Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 */

import { getSupportedMajorVersions } from 'hostdb'
import { resolveEngineVersion } from '../../core/version-resolver'
import { buildVersionMap } from '../version-map-builder'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'influxdb'

export const INFLUXDB_VERSION_MAP: Record<string, string> =
  buildVersionMap(ENGINE)

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export function getFullVersion(majorVersion: string): string | null {
  return resolveEngineVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = resolveEngineVersion(ENGINE, version)
  if (resolved) return resolved

  const parts = version.split('.')
  const isValidFormat =
    parts.length >= 1 &&
    parts.length <= 3 &&
    parts.every((p) => /^\d+$/.test(p))

  if (!isValidFormat) {
    logDebug(
      `InfluxDB version '${version}' has invalid format, may not be available in hostdb`,
    )
  } else {
    logDebug(
      `InfluxDB version '${version}' not in hostdb, may not be available for download`,
    )
  }
  return version
}
