/**
 * EDB Binary URL Builder for Windows
 *
 * EnterpriseDB (EDB) provides official PostgreSQL binaries for Windows.
 * Unlike zonky.io which uses predictable Maven URLs, EDB uses file IDs.
 *
 * Download page: https://www.enterprisedb.com/download-postgresql-binaries
 */

/**
 * Mapping of PostgreSQL versions to EDB file IDs
 * These IDs are from the EDB download page and need to be updated when new versions are released.
 *
 * Format: 'version' -> 'fileId'
 */
export const EDB_FILE_IDS: Record<string, string> = {
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
 * Fallback version map for major versions
 * Used when only major version is specified
 */
export const EDB_VERSION_MAP: Record<string, string> = {
  '14': '14.20.0',
  '15': '15.15.0',
  '16': '16.11.0',
  '17': '17.7.0',
}

/**
 * Supported major versions for Windows
 */
export const WINDOWS_SUPPORTED_VERSIONS = ['14', '15', '16', '17']

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
    const fullVersion = EDB_VERSION_MAP[major]
    if (fullVersion) {
      fileId = EDB_FILE_IDS[fullVersion]
    }
  }

  if (!fileId) {
    throw new Error(
      `Unsupported PostgreSQL version for Windows: ${version}. ` +
        `Supported versions: ${WINDOWS_SUPPORTED_VERSIONS.join(', ')}`,
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
  return EDB_VERSION_MAP[majorVersion] || null
}

/**
 * Check if a version is supported on Windows
 *
 * @param version - Version to check (major or full)
 * @returns true if the version is supported
 */
export function isWindowsVersionSupported(version: string): boolean {
  // Check if we have a file ID for this version
  if (EDB_FILE_IDS[version]) {
    return true
  }

  // Check if it's a major version we support
  const major = version.split('.')[0]
  return WINDOWS_SUPPORTED_VERSIONS.includes(major)
}

/**
 * Get available Windows versions (for display purposes)
 *
 * @returns Record of major versions to their full versions
 */
export function getAvailableWindowsVersions(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const major of WINDOWS_SUPPORTED_VERSIONS) {
    const fullVersion = EDB_VERSION_MAP[major]
    if (fullVersion) {
      grouped[major] = [fullVersion]
    }
  }
  return grouped
}
