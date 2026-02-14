/**
 * FerretDB version mapping
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * FerretDB v2 requires two binaries:
 * - ferretdb: The MongoDB-compatible proxy
 * - postgresql-documentdb: PostgreSQL 17 with DocumentDB extension
 *
 * FerretDB v1 requires:
 * - ferretdb (from hostdb engine "ferretdb-v1"): The MongoDB-compatible proxy
 * - Plain PostgreSQL (reuses postgresqlBinaryManager)
 *
 * To update: Check releases.json, find databases.ferretdb and databases.ferretdb-v1,
 * copy all version strings.
 */

import { logDebug } from '../../core/error-handler'
import { compareVersions } from '../../core/version-utils'

/**
 * Map major versions to full versions for FerretDB proxy
 * Keys are major versions (e.g., "1", "2")
 * Values are full versions from hostdb releases.json
 *
 * v1.x uses plain PostgreSQL as backend (all platforms incl. Windows)
 * v2.x uses postgresql-documentdb as backend (macOS/Linux only)
 */
export const FERRETDB_VERSION_MAP: Record<string, string> = {
  // v1: uses plain PostgreSQL backend
  '1': '1.24.2',
  '1.24': '1.24.2',
  '1.24.2': '1.24.2',
  // v2: uses postgresql-documentdb backend
  '2': '2.7.0',
  '2.7': '2.7.0',
  '2.7.0': '2.7.0',
}

/**
 * Map for postgresql-documentdb backend versions
 * Format: postgresql-{pg_version}-{documentdb_version}
 * e.g., "17-0.107.0" means PostgreSQL 17 with DocumentDB extension 0.107.0
 */
export const DOCUMENTDB_VERSION_MAP: Record<string, string> = {
  // Default backend version
  '17': '17-0.107.0',
  // Full version (identity)
  '17-0.107.0': '17-0.107.0',
}

/**
 * Supported major FerretDB versions (1-part format).
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = ['1', '2']

/**
 * Default postgresql-documentdb version to use with FerretDB v2
 */
export const DEFAULT_DOCUMENTDB_VERSION = '17-0.107.0'

/**
 * Default PostgreSQL version to use as backend for FerretDB v1
 * v1 uses plain PostgreSQL (no DocumentDB extension needed)
 */
export const DEFAULT_V1_POSTGRESQL_VERSION = '17'

/**
 * Check if a FerretDB version is v1.x (uses plain PostgreSQL backend)
 * vs v2.x (uses postgresql-documentdb backend)
 *
 * @param version - Version string (can be major, major.minor, or full)
 * @returns true if the version is v1.x
 */
export function isV1(version: string): boolean {
  const normalized = normalizeVersion(version)
  return normalized.startsWith('1.')
}

/**
 * Version map for FerretDB v2 only (hostdb engine: "ferretdb")
 * Used by hostdb-sync tests to verify against the correct hostdb engine.
 */
export const FERRETDB_V2_VERSION_MAP: Record<string, string> =
  Object.fromEntries(
    Object.entries(FERRETDB_VERSION_MAP).filter(([, v]) => v.startsWith('2.')),
  )

/**
 * Version map for FerretDB v1 only (hostdb engine: "ferretdb-v1")
 * Used by hostdb-sync tests to verify against the correct hostdb engine.
 */
export const FERRETDB_V1_VERSION_MAP: Record<string, string> =
  Object.fromEntries(
    Object.entries(FERRETDB_VERSION_MAP).filter(([, v]) => v.startsWith('1.')),
  )

/**
 * Fallback map of major versions to stable patch versions
 * Used when hostdb repository is unreachable.
 * Spread into a new object so it can diverge from FERRETDB_VERSION_MAP if needed.
 */
export const FALLBACK_VERSION_MAP: Record<string, string> = {
  ...FERRETDB_VERSION_MAP,
}

/**
 * Get the full version for a FerretDB version string
 * @param version - Version string (e.g., "2", "2.7", "2.7.0")
 * @returns Full version or null if not found
 */
export function getFullVersion(version: string): string | null {
  // Try exact match first
  if (FERRETDB_VERSION_MAP[version]) {
    return FERRETDB_VERSION_MAP[version]
  }

  // Try matching major only (e.g., "2" -> highest 2.x version)
  const majorOnly = version.split('.')[0]
  const matchingVersions = Object.entries(FERRETDB_VERSION_MAP)
    .filter(([key]) => key.split('.')[0] === majorOnly)
    .sort(([, aValue], [, bValue]) => compareVersions(bValue, aValue)) // Sort descending by full semver value

  if (matchingVersions.length > 0) {
    return matchingVersions[0][1]
  }

  return null
}

/**
 * Normalize a version string to a full version
 * @param version - Version string (major, major.minor, or full)
 * @returns Full version string
 */
export function normalizeVersion(version: string): string {
  // If already a full version (x.y.z), return as-is
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    return version
  }

  // Delegate to getFullVersion for major/major.minor lookup
  const fullVersion = getFullVersion(version)
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version format - log debug and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  logDebug(
    `FerretDB version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}

/**
 * Normalize a postgresql-documentdb version string
 * @param version - Version string (e.g., "17", "17-0.107.0")
 * @returns Full version string (e.g., "17-0.107.0")
 */
export function normalizeDocumentDBVersion(version: string): string {
  if (DOCUMENTDB_VERSION_MAP[version]) {
    return DOCUMENTDB_VERSION_MAP[version]
  }
  // Return as-is if not found
  return version
}
