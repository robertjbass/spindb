import {
  fetchAvailableVersions as fetchHostdbVersions,
  getLatestVersion as getHostdbLatestVersion,
} from './hostdb-releases'
import { REDIS_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'

/**
 * Fallback map of major versions to stable patch versions
 * Used when hostdb repository is unreachable
 */
export const FALLBACK_VERSION_MAP: Record<string, string> = REDIS_VERSION_MAP

/**
 * Supported major versions (in order of display)
 */
export { SUPPORTED_MAJOR_VERSIONS }

/**
 * Fetch available versions from hostdb repository
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  return await fetchHostdbVersions()
}

/**
 * Get the latest version for a major version from hostdb
 */
export async function getLatestVersion(major: string): Promise<string> {
  return await getHostdbLatestVersion(major)
}

// Legacy export for backward compatibility
export const VERSION_MAP = FALLBACK_VERSION_MAP

/**
 * Supported platform identifiers for hostdb downloads.
 * hostdb uses standard Node.js platform naming - this set validates
 * that a platform/arch combination is supported, not transforms it.
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
 * hostdb uses standard platform naming that matches Node.js identifiers directly.
 * This function validates the platform/arch combination is supported.
 *
 * @param platform - Node.js platform (e.g., 'darwin', 'linux', 'win32')
 * @param arch - Node.js architecture (e.g., 'arm64', 'x64')
 * @returns hostdb platform identifier or undefined if unsupported
 */
export function getHostdbPlatform(
  platform: string,
  arch: string,
): string | undefined {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.has(key) ? key : undefined
}

/**
 * Build the download URL for Redis binaries from hostdb
 *
 * Format: https://github.com/robertjbass/hostdb/releases/download/redis-{version}/redis-{version}-{platform}-{arch}.{ext}
 *
 * @param version - Redis version (e.g., '7', '7.4.7')
 * @param platform - Platform identifier (e.g., 'darwin', 'linux', 'win32')
 * @param arch - Architecture identifier (e.g., 'arm64', 'x64')
 * @returns Download URL for the binary
 */
export function getBinaryUrl(
  version: string,
  platform: string,
  arch: string,
): string {
  const platformKey = `${platform}-${arch}`
  const hostdbPlatform = getHostdbPlatform(platform, arch)
  if (!hostdbPlatform) {
    throw new Error(`Unsupported platform: ${platformKey}`)
  }

  // Normalize version (handles major version lookup and X.Y -> X.Y.Z conversion)
  const fullVersion = normalizeVersion(version, VERSION_MAP)

  const tag = `redis-${fullVersion}`
  // Windows uses .zip, Unix uses .tar.gz
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'
  const filename = `redis-${fullVersion}-${hostdbPlatform}.${ext}`

  return `https://github.com/robertjbass/hostdb/releases/download/${tag}/${filename}`
}

/**
 * Normalize version string to X.Y.Z format
 *
 * @param version - Version string (e.g., '7', '7.4', '7.4.7')
 * @param versionMap - Optional version map for major version lookup
 * @returns Normalized version (e.g., '7.4.7')
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = VERSION_MAP,
): string {
  // Check if it's a version key in the map (handles "7", "7.4", etc.)
  if (versionMap[version]) {
    return versionMap[version]
  }

  const parts = version.split('.')

  // If it's already a full version (X.Y.Z), return as-is
  if (parts.length === 3) {
    return version
  }

  // For single-part versions, check the map by major
  if (parts.length === 1) {
    const mapped = versionMap[version]
    if (mapped) {
      return mapped
    }
  }

  // For two-part versions, look up by major for better version
  if (parts.length === 2) {
    const major = parts[0]
    const mapped = versionMap[major]
    if (mapped) {
      return mapped
    }
  }

  // Unknown version format - warn and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  console.warn(
    `Redis version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}

/**
 * Get the full version string for a major version
 *
 * @param majorVersion - Major version (e.g., '7', '8')
 * @returns Full version string (e.g., '7.4.7') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return VERSION_MAP[majorVersion] || null
}
