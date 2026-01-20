import { FALLBACK_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

/**
 * Supported platform identifiers for hostdb downloads.
 * hostdb uses standard Node.js platform naming.
 */
const SUPPORTED_PLATFORMS = new Set([
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
  return SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * Build the download URL for MySQL binaries from hostdb
 *
 * Format: https://github.com/robertjbass/hostdb/releases/download/mysql-{version}/mysql-{version}-{platform}-{arch}.tar.gz
 * Windows: https://github.com/robertjbass/hostdb/releases/download/mysql-{version}/mysql-{version}-{platform}-{arch}.zip
 *
 * @param version - MySQL version (e.g., '8.0', '8.0.40')
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
  const fullVersion = normalizeVersion(version, FALLBACK_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.MySQL, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * Normalize version string to X.Y.Z format
 *
 * @param version - Version string (e.g., '8.0', '8.0.40', '9')
 * @param versionMap - Optional version map for major version lookup
 * @returns Normalized version (e.g., '8.0.40')
 * @throws TypeError if version string is malformed
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = FALLBACK_VERSION_MAP,
): string {
  // Check if it's a major version in the map
  if (versionMap[version]) {
    return versionMap[version]
  }

  // Validate version format: must be numeric semver-like (X, X.Y, or X.Y.Z)
  const versionPattern = /^\d+(\.\d+){0,2}$/
  if (!versionPattern.test(version)) {
    throw new TypeError(
      `Invalid MySQL version format: "${version}". ` +
        `Expected format: X, X.Y, or X.Y.Z (e.g., "8", "8.0", "8.0.40")`,
    )
  }

  // Normalize to X.Y.Z format
  const parts = version.split('.')
  if (parts.length === 1) {
    return `${version}.0.0`
  } else if (parts.length === 2) {
    return `${version}.0`
  }
  return version
}

/**
 * Get the full version string for a major version
 *
 * @param majorVersion - Major version (e.g., '8.0', '9')
 * @returns Full version string (e.g., '8.0.40') or null if not supported
 */
