/**
 * FerretDB binary URL generation for hostdb
 *
 * Generates download URLs for FerretDB binaries from the hostdb GitHub releases.
 * FerretDB requires two binaries:
 * - ferretdb: MongoDB-compatible proxy (all platforms)
 * - postgresql-documentdb: PostgreSQL 17 + DocumentDB extension (all platforms)
 */

import { normalizeVersion, normalizeDocumentDBVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

// Supported platforms for FerretDB (both proxy and backend)
export const FERRETDB_SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

// Supported platforms for postgresql-documentdb backend
export const DOCUMENTDB_SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

/**
 * Map Node.js platform/arch to hostdb platform key
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return FERRETDB_SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * Check if the current platform supports FerretDB
 */
export function isPlatformSupported(platform: Platform, arch: Arch): boolean {
  const key = `${platform}-${arch}`
  return FERRETDB_SUPPORTED_PLATFORMS.has(key)
}

/**
 * Get the download URL for FerretDB proxy binary
 *
 * @param version - FerretDB version (major or full)
 * @param platform - Operating system (darwin, linux, win32)
 * @param arch - Architecture (arm64, x64)
 * @returns Download URL
 */
export function getFerretDBBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const hostdbPlatform = getHostdbPlatform(platform, arch)

  if (!hostdbPlatform) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. FerretDB hostdb binaries are available for: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64`,
    )
  }

  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.FerretDB, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}

/**
 * Get the download URL for postgresql-documentdb backend binary
 *
 * @param version - DocumentDB version (e.g., "17-0.107.0")
 * @param platform - Operating system (darwin, linux, win32)
 * @param arch - Architecture (arm64, x64)
 * @returns Download URL
 */
export function getDocumentDBBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeDocumentDBVersion(version)
  const key = `${platform}-${arch}`

  if (!DOCUMENTDB_SUPPORTED_PLATFORMS.has(key)) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. postgresql-documentdb binaries are available for: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64`,
    )
  }

  // postgresql-documentdb uses a specific tag format: postgresql-documentdb-{version}
  // e.g., postgresql-documentdb-17-0.107.0
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  // Build URL manually since it's a different engine name format
  // Format: https://github.com/robertjbass/hostdb/releases/download/postgresql-documentdb-{version}/postgresql-documentdb-{version}-{platform}-{arch}.{ext}
  const baseUrl = 'https://github.com/robertjbass/hostdb/releases/download'
  const tag = `postgresql-documentdb-${fullVersion}`
  const filename = `postgresql-documentdb-${fullVersion}-${key}.${ext}`

  return `${baseUrl}/${tag}/${filename}`
}

/**
 * Get the combined binary URLs for FerretDB (both proxy and backend)
 *
 * @param version - FerretDB version (major or full)
 * @param backendVersion - postgresql-documentdb version (e.g., "17-0.107.0")
 * @param platform - Operating system
 * @param arch - Architecture
 * @returns Object with ferretdb and documentdb URLs
 */
export function getBinaryUrls(
  version: string,
  backendVersion: string,
  platform: Platform,
  arch: Arch,
): { ferretdb: string; documentdb: string } {
  // Validate platform supports FerretDB
  if (!isPlatformSupported(platform, arch)) {
    throw new Error(
      `FerretDB is not available on ${platform}-${arch}.\n` +
        'Supported platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64',
    )
  }

  return {
    ferretdb: getFerretDBBinaryUrl(version, platform, arch),
    documentdb: getDocumentDBBinaryUrl(backendVersion, platform, arch),
  }
}
