/**
 * PostgreSQL Version Maps
 *
 * Shared version mappings used by both hostdb (macOS/Linux) and EDB (Windows).
 * Both sources use the same PostgreSQL releases.
 *
 * When updating versions:
 * 1. Check hostdb GitHub releases for new versions:
 *    https://github.com/robertjbass/hostdb/releases
 * 2. Check EDB download page for matching Windows versions:
 *    https://www.enterprisedb.com/download-postgresql-binaries
 * 3. Update POSTGRESQL_VERSION_MAP with new full versions
 * 4. Update EDB_FILE_IDS in edb-binary-urls.ts with new file IDs
 */

/**
 * Map of major PostgreSQL versions to their latest stable patch versions.
 * Used for both hostdb (macOS/Linux) and EDB (Windows) binaries.
 */
export const POSTGRESQL_VERSION_MAP: Record<string, string> = {
  '14': '14.20.0',
  '15': '15.15.0',
  '16': '16.11.0',
  '17': '17.7.0',
  '18': '18.1.0',
}

/**
 * Supported major PostgreSQL versions.
 * Derived from POSTGRESQL_VERSION_MAP keys.
 */
export const SUPPORTED_MAJOR_VERSIONS = Object.keys(POSTGRESQL_VERSION_MAP)

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '17')
 * @returns Full version string (e.g., '17.7.0') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return POSTGRESQL_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '17', '17.7', '17.7.0')
 * @returns Normalized version (e.g., '17.7.0')
 */
export function normalizeVersion(version: string): string {
  // If it's a major version only, use the map
  const fullVersion = POSTGRESQL_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Normalize to X.Y.Z format
  const parts = version.split('.')
  if (parts.length === 2) {
    return `${version}.0`
  }

  return version
}
