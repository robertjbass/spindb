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

/**
 * True for the legacy hostdb build revisions that bundled pg_cron separately
 * (e.g. "18.6.0-cron.1", hostdb 0.44.0, spindb 0.72.0). pg_cron now ships
 * inside the standard builds and support is detected from the binary itself
 * (hasPgCron). This name check remains only as a compatibility shim: databases
 * created on a -cron.N revision stay pinned to it, and no other database is
 * ever moved onto one or offered one.
 */
export function isCronBuildRevision(version: string): boolean {
  return /-cron\.\d+$/.test(version.split('+')[0])
}
