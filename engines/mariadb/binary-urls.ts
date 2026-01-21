import { MARIADB_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

/**
 * Get the hostdb platform identifier
 *
 * hostdb uses standard platform naming (e.g., 'darwin-arm64', 'linux-x64')
 * which matches Node.js platform identifiers directly.
 *
 * @param platform - Node.js platform (e.g., 'darwin', 'linux', 'win32')
 * @param arch - Node.js architecture (e.g., 'arm64', 'x64')
 * @returns hostdb platform identifier or null if unsupported
 */
// Supported platform/arch combinations for MariaDB hostdb binaries
const SUPPORTED_PLATFORM_KEYS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORM_KEYS.has(key) ? key : null
}

/**
 * Build the download URL for MariaDB binaries from hostdb
 *
 * Format: https://github.com/robertjbass/hostdb/releases/download/mariadb-{version}/mariadb-{version}-{platform}-{arch}.tar.gz
 * Windows: https://github.com/robertjbass/hostdb/releases/download/mariadb-{version}/mariadb-{version}-{platform}-{arch}.zip
 *
 * @param version - MariaDB version (e.g., '11.8', '11.8.5')
 * @param platform - Platform identifier (e.g., 'darwin', 'linux')
 * @param arch - Architecture identifier (e.g., 'arm64', 'x64')
 * @returns Download URL for the binary
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const platformKey = `${platform}-${arch}`
  const hostdbPlatform = getHostdbPlatform(platform, arch)
  if (!hostdbPlatform) {
    throw new Error(`Unsupported platform: ${platformKey}`)
  }

  // Normalize version (handles major version lookup and X.Y -> X.Y.Z conversion)
  const fullVersion = normalizeVersion(version, MARIADB_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.MariaDB, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * Normalize version string to X.Y.Z format
 *
 * Note: MariaDB does not use validateSemverLikeVersion() because:
 * 1. MariaDB versions may have suffixes (e.g., "11.8.5-MariaDB" in --version output)
 * 2. Version map lookup handles known versions; unknown versions pass through
 *    and will fail at download time with a clear 404 error
 *
 * @param version - Version string (e.g., '11.8', '11.8.5')
 * @param versionMap - Optional version map for major version lookup
 * @returns Normalized version (e.g., '11.8.5')
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = MARIADB_VERSION_MAP,
): string {
  // Check if it's a major version in the map
  if (versionMap[version]) {
    return versionMap[version]
  }

  // Normalize to X.Y.Z format
  const parts = version.split('.')
  if (parts.length === 2) {
    return `${version}.0`
  }
  return version
}

/**
 * Get the full version string for a major version
 *
 * @param majorVersion - Major version (e.g., '11.8')
 * @returns Full version string (e.g., '11.8.5') or null if not supported
 */
