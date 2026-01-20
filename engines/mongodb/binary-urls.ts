/**
 * MongoDB binary URL generation for hostdb
 *
 * Generates download URLs for MongoDB binaries from the hostdb GitHub releases.
 * All platforms (macOS, Linux, Windows) use hostdb binaries.
 */

import { normalizeVersion } from './version-maps'
import { Platform, type Arch } from '../../types'

const HOSTDB_BASE_URL =
  'https://github.com/robertjbass/hostdb/releases/download'

// Supported platforms for MongoDB hostdb binaries
export const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'] as const
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number]

// Supported architectures
export const SUPPORTED_ARCHS = ['arm64', 'x64'] as const
export type SupportedArch = (typeof SUPPORTED_ARCHS)[number]

// Supported platform/arch combinations for MongoDB hostdb binaries
const SUPPORTED_PLATFORM_KEYS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

// Map Node.js platform/arch to hostdb platform key
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORM_KEYS.has(key) ? key : null
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
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const platformKey = getHostdbPlatform(platform, arch)

  if (!platformKey) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. MongoDB hostdb binaries are available for: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64`,
    )
  }

  // Windows uses .zip, Unix uses .tar.gz
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'
  return `${HOSTDB_BASE_URL}/mongodb-${fullVersion}/mongodb-${fullVersion}-${platformKey}.${ext}`
}

// Check if a platform/arch combination is supported
export function isPlatformSupported(platform: Platform, arch: Arch): boolean {
  return getHostdbPlatform(platform, arch) !== null
}

