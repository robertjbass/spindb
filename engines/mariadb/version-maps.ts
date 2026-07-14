/**
 * MariaDB Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 *
 * Note: SUPPORTED_MAJOR_VERSIONS is 2-part (e.g., '11.8') to preserve the
 * convention used by `core/version-migration.ts:getMajorVersion()`, which
 * groups patch versions under their major.minor LTS line. 1-part keys like
 * '10' and '11' are still resolvable via the MAP (LTS-pick).
 */

import {
  resolveVersion as hostdbResolveVersion,
  listVersions,
} from 'hostdb'
import { buildVersionMap } from '../version-map-builder'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'mariadb'

export const MARIADB_VERSION_MAP: Record<string, string> = buildVersionMap(ENGINE)

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
    `MariaDB version '${version}' not in hostdb, may not be available for download`,
  )
  return version
}
