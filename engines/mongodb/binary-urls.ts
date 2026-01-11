/**
 * MongoDB binary URL generation for hostdb
 *
 * Generates download URLs for MongoDB binaries from the hostdb GitHub releases.
 * All platforms (macOS, Linux, Windows) use hostdb binaries.
 */

import { normalizeVersion } from './version-maps'

const HOSTDB_BASE_URL =
  'https://github.com/robertjbass/hostdb/releases/download'

/**
 * Supported platforms for MongoDB hostdb binaries
 */
export const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'] as const
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number]

/**
 * Supported architectures
 */
export const SUPPORTED_ARCHS = ['arm64', 'x64'] as const
export type SupportedArch = (typeof SUPPORTED_ARCHS)[number]

/**
 * Map Node.js platform/arch to hostdb platform key
 */
export function getHostdbPlatform(
  platform: string,
  arch: string,
): string | null {
  const key = `${platform}-${arch}`
  const mapping: Record<string, string> = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux-x64',
    'win32-x64': 'win32-x64',
  }
  return mapping[key] || null
}

/**
 * Get the download URL for MongoDB binaries
 *
 * @param version - MongoDB version (major.minor or full)
 * @param platform - Operating system (darwin, linux, win32)
 * @param arch - Architecture (arm64, x64)
 * @returns Download URL
 */
export function getBinaryUrl(
  version: string,
  platform: string,
  arch: string,
): string {
  const fullVersion = normalizeVersion(version)
  const platformKey = getHostdbPlatform(platform, arch)

  if (!platformKey) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. MongoDB hostdb binaries are available for: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64`,
    )
  }

  // Windows uses .zip, Unix uses .tar.gz
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'
  return `${HOSTDB_BASE_URL}/mongodb-${fullVersion}/mongodb-${fullVersion}-${platformKey}.${ext}`
}

/**
 * Check if a platform/arch combination is supported
 */
export function isPlatformSupported(platform: string, arch: string): boolean {
  return getHostdbPlatform(platform, arch) !== null
}

// Re-export for convenience
export { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'
