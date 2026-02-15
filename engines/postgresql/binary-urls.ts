import { POSTGRESQL_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { validateSemverLikeVersion } from '../../core/version-utils'
import { Engine, Platform, type Arch } from '../../types'

// Supported platform/arch combinations for PostgreSQL hostdb binaries
const SUPPORTED_PLATFORM_KEYS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

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

export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORM_KEYS.has(key) ? key : null
}

/**
 * Build the download URL for PostgreSQL binaries from hostdb
 *
 * Format: https://registry.layerbase.host/postgresql-{version}/postgresql-{version}-{platform}-{arch}.tar.gz
 *
 * @param version - PostgreSQL version (e.g., '17', '17.7.0')
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

  // Normalize version (handles major version lookup and X.Y -> X.Y.0 conversion)
  const fullVersion = normalizeVersion(version, POSTGRESQL_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.PostgreSQL, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * Normalize version string to X.Y.Z format
 *
 * @param version - Version string (e.g., '17', '17.7', '17.7.0')
 * @param versionMap - Optional version map for major version lookup
 * @returns Normalized version (e.g., '17.7.0')
 * @throws TypeError if version string is malformed
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = POSTGRESQL_VERSION_MAP,
): string {
  // Check if it's a major version in the map
  if (versionMap[version]) {
    return versionMap[version]
  }

  // Validate version format: must be numeric semver-like (X, X.Y, or X.Y.Z)
  validateSemverLikeVersion(version, 'PostgreSQL')

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
 * @param majorVersion - Major version (e.g., '17')
 * @returns Full version string (e.g., '17.7.0') or null if not supported
 */
