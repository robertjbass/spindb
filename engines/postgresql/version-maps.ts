/**
 * PostgreSQL Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 */

import { getSupportedMajorVersions } from 'hostdb'
import { resolveEngineVersion } from '../../core/version-resolver'
import { buildVersionMap } from '../version-map-builder'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'postgresql'

export const POSTGRESQL_VERSION_MAP: Record<string, string> =
  buildVersionMap(ENGINE)

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export function getFullVersion(majorVersion: string): string | null {
  return resolveEngineVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = resolveEngineVersion(ENGINE, version)
  if (resolved) return resolved
  // Debug, not warn: this is now on the create/start path too (resolveFullVersion
  // delegates here), and the download layer reports the real failure with the
  // list of versions that do exist.
  logDebug(
    `PostgreSQL version '${version}' not in hostdb, may not be available for download`,
  )
  return version
}
