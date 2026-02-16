import { WEAVIATE_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { logDebug } from '../../core/error-handler'
import { Engine, Platform, type Arch } from '../../types'

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
 * Build the download URL for Weaviate binaries from hostdb
 *
 * Format: https://registry.layerbase.host/weaviate-{version}/weaviate-{version}-{platform}-{arch}.{ext}
 *
 * @param version - Weaviate version (e.g., '1', '1.35.7')
 * @param platform - Platform identifier (e.g., 'darwin', 'linux', 'win32')
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
    const supported = Array.from(SUPPORTED_PLATFORMS).join(', ')
    throw new Error(
      `Unsupported platform: ${platformKey}. Supported platforms: ${supported}`,
    )
  }

  // Normalize version (handles major version lookup and X.Y -> X.Y.Z conversion)
  const fullVersion = normalizeVersion(version, WEAVIATE_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.Weaviate, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * Normalize version string to X.Y.Z format
 *
 * @param version - Version string (e.g., '1', '1.35', '1.35.7')
 * @param versionMap - Optional version map for major version lookup
 * @returns Normalized version (e.g., '1.35.7')
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = WEAVIATE_VERSION_MAP,
): string {
  // Check if it's an exact key in the map (handles "1", "1.35", etc.)
  if (versionMap[version]) {
    return versionMap[version]
  }

  const parts = version.split('.')

  // If it's already a full version (X.Y.Z), return as-is
  if (parts.length === 3) {
    return version
  }

  // For two-part versions (e.g., "1.35"), first try exact two-part key, then fall back to major
  if (parts.length === 2) {
    const twoPart = `${parts[0]}.${parts[1]}`
    if (versionMap[twoPart]) {
      return versionMap[twoPart]
    }
    // Fall back to major version for latest patch
    const major = parts[0]
    const mapped = versionMap[major]
    if (mapped) {
      return mapped
    }
  }

  // Unknown version format - log and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  logDebug(
    `Weaviate version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
