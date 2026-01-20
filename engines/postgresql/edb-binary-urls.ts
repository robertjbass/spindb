/**
 * EDB Binary URL Builder for Windows
 *
 * EnterpriseDB (EDB) provides official PostgreSQL binaries for Windows.
 * Unlike zonky.io which uses predictable Maven URLs, EDB uses opaque file IDs
 * that must be manually discovered and updated when new versions are released.
 *
 * ## Why EDB File IDs Need Manual Updates
 *
 * EDB's download system uses numeric file IDs (e.g., `fileid=1259913`) rather
 * than version-based URLs. These IDs are not predictable and change with each
 * release. When PostgreSQL releases a new version, EDB assigns a new file ID
 * that we must discover and add to EDB_FILE_IDS below.
 *
 * ## How to Update EDB File IDs
 *
 * When a new PostgreSQL version is released:
 *
 * 1. Visit: https://www.enterprisedb.com/download-postgresql-binaries
 *
 * 2. Find the new version in the download table (e.g., "18.1" under Windows x86-64)
 *
 * 3. Right-click the download link and copy the URL. It will look like:
 *    https://sbp.enterprisedb.com/getfile.jsp?fileid=1259913
 *
 * 4. Extract the numeric file ID from the URL (e.g., "1259913")
 *
 * 5. Add entries to EDB_FILE_IDS below:
 *    - Full version: '18.1.0': '1259913'
 *    - Major alias:  '18': '1259913'
 *
 * 6. Also update version-maps.ts with the new version mapping
 *
 * ## Important Notes
 *
 * - EDB file IDs are REQUIRED for Windows support. Without them, Windows
 *   users cannot download PostgreSQL binaries and container creation fails.
 * - The file IDs may change if EDB re-uploads binaries, but this is rare.
 * - Always test Windows CI after updating to verify the new IDs work.
 *
 * Download page: https://www.enterprisedb.com/download-postgresql-binaries
 */

import {
  POSTGRESQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from './version-maps'

/**
 * Mapping of PostgreSQL versions to EDB file IDs
 * These IDs are from the EDB download page and need to be updated when new versions are released.
 *
 * Format: 'version' -> 'fileId'
 *
 * IMPORTANT: When updating POSTGRESQL_VERSION_MAP in version-maps.ts,
 * also update this map with the corresponding EDB file IDs.
 */
export const EDB_FILE_IDS: Record<string, string> = {
  // PostgreSQL 18.x
  '18.1.0': '1259913',
  '18': '1259913', // Alias for latest 18.x

  // PostgreSQL 17.x
  '17.7.0': '1259911',
  '17': '1259911', // Alias for latest 17.x

  // PostgreSQL 16.x
  '16.11.0': '1259906',
  '16': '1259906', // Alias for latest 16.x

  // PostgreSQL 15.x
  '15.15.0': '1259903',
  '15': '1259903', // Alias for latest 15.x

  // PostgreSQL 14.x
  '14.20.0': '1259900',
  '14': '1259900', // Alias for latest 14.x
}

/**
 * Get the EDB download URL for a PostgreSQL version on Windows
 *
 * @param version - PostgreSQL version (e.g., '17', '17.7.0')
 * @returns Download URL for the Windows binary ZIP
 * @throws Error if version is not supported
 */
export function getEDBBinaryUrl(version: string): string {
  // Try direct lookup first
  let fileId = EDB_FILE_IDS[version]

  // If not found, try to normalize version
  if (!fileId) {
    // Try major version
    const major = version.split('.')[0]
    const fullVersion = POSTGRESQL_VERSION_MAP[major]
    if (fullVersion) {
      fileId = EDB_FILE_IDS[fullVersion]
    }
  }

  if (!fileId) {
    throw new Error(
      `Unsupported PostgreSQL version for Windows: ${version}. ` +
        `Supported versions: ${SUPPORTED_MAJOR_VERSIONS.join(', ')}`,
    )
  }

  return `https://sbp.enterprisedb.com/getfile.jsp?fileid=${fileId}`
}

/**
 * Get the full version string for a major version on Windows
 *
 * @param majorVersion - Major version (e.g., '17')
 * @returns Full version string (e.g., '17.7.0') or null if not supported
 */
export function getWindowsFullVersion(majorVersion: string): string | null {
  return POSTGRESQL_VERSION_MAP[majorVersion] || null
}

/**
 * Check if a version is supported on Windows
 *
 * @param version - Version to check (major or full)
 * @returns true if the version is supported AND has an EDB file ID
 */
export function isWindowsVersionSupported(version: string): boolean {
  // Check if we have a file ID for this version directly
  if (EDB_FILE_IDS[version]) {
    return true
  }

  // Check if it's a major version that maps to a full version with a file ID
  const major = version.split('.')[0]
  const fullVersion = POSTGRESQL_VERSION_MAP[major]
  if (fullVersion && EDB_FILE_IDS[fullVersion]) {
    return true
  }

  return false
}

/**
 * Get available Windows versions (for display purposes)
 *
 * @returns Record of major versions to their full versions
 */
export function getAvailableWindowsVersions(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const major of SUPPORTED_MAJOR_VERSIONS) {
    const fullVersion = POSTGRESQL_VERSION_MAP[major]
    // Only include if we have a file ID for it
    if (fullVersion && EDB_FILE_IDS[fullVersion]) {
      grouped[major] = [fullVersion]
    }
  }
  return grouped
}
