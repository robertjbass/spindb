import { TIGERBEETLE_VERSION_MAP } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { logDebug } from '../../core/error-handler'
import { Engine, Platform, type Arch } from '../../types'

/**
 * Supported platform identifiers for hostdb downloads.
 * TigerBeetle supports all 5 platforms.
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
 * Build the download URL for TigerBeetle binaries from hostdb
 *
 * @param version - TigerBeetle version (e.g., '0.16', '0.16.70')
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
  const fullVersion = normalizeVersion(version, TIGERBEETLE_VERSION_MAP)
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.TigerBeetle, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * Normalize version string to X.Y.Z format
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = TIGERBEETLE_VERSION_MAP,
): string {
  // Check if it's an exact key in the map
  if (versionMap[version]) {
    return versionMap[version]
  }

  const parts = version.split('.')

  // If it's already a full version (X.Y.Z), return as-is
  if (parts.length === 3) {
    return version
  }

  // For two-part versions (e.g., "0.16"), try exact key then fall back to major
  if (parts.length === 2) {
    const twoPart = `${parts[0]}.${parts[1]}`
    if (versionMap[twoPart]) {
      return versionMap[twoPart]
    }
    const major = parts[0]
    const mapped = versionMap[major]
    if (mapped) {
      return mapped
    }
  }

  logDebug(
    `TigerBeetle version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
