/**
 * MySQL Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 *
 * Note: SUPPORTED_MAJOR_VERSIONS is 2-part (e.g., '8.4') to preserve the
 * convention used by `core/version-migration.ts:getMajorVersion()`. The 1-part
 * keys '8' and '9' still resolve via the MAP (LTS-pick: '8' → 8.4.9, not 9.6.0).
 *
 * Deprecated patches (8.0.40, 9.1.0, 9.5.0) remain resolvable so existing
 * containers keep working — hostdb's `enabled !== false` check keeps them in
 * the available-versions list; only `enabled: false` removes a version entirely.
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'mysql'

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

export const MYSQL_VERSION_MAP: Record<string, string> = buildVersionMap()

export const SUPPORTED_MAJOR_VERSIONS = listVersions(ENGINE, {
  format: 'major-minor',
})

export const FALLBACK_VERSION_MAP: Record<string, string> = MYSQL_VERSION_MAP

export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved

  const parts = version.split('.')
  const isValidFormat =
    parts.length >= 1 &&
    parts.length <= 3 &&
    parts.every((p) => /^\d+$/.test(p))

  if (!isValidFormat) {
    logDebug(
      `MySQL version '${version}' has invalid format, may not be available in hostdb`,
    )
  } else {
    logDebug(
      `MySQL version '${version}' not in hostdb, may not be available for download`,
    )
  }
  return version
}
