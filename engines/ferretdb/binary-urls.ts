/**
 * FerretDB binary URL generation for hostdb
 *
 * Generates download URLs for FerretDB binaries from the hostdb GitHub releases.
 *
 * FerretDB v2 requires two binaries:
 * - ferretdb: MongoDB-compatible proxy (hostdb engine: "ferretdb")
 * - postgresql-documentdb: PostgreSQL 17 + DocumentDB extension
 *
 * FerretDB v1 requires:
 * - ferretdb: MongoDB-compatible proxy (hostdb engine: "ferretdb-v1")
 * - Plain PostgreSQL (managed by postgresqlBinaryManager, not downloaded here)
 *
 * v1 supports all platforms including Windows.
 * v2 is macOS/Linux only (postgresql-documentdb has Windows startup issues).
 */

import {
  normalizeVersion,
  normalizeDocumentDBVersion,
  isV1,
} from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

// Supported platforms for FerretDB v2 (requires postgresql-documentdb)
// Windows is excluded due to postgresql-documentdb startup issues
export const FERRETDB_V2_SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
])

// Supported platforms for FerretDB v1 (uses plain PostgreSQL)
// All platforms including Windows
export const FERRETDB_V1_SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

// Supported platforms for postgresql-documentdb backend (v2 only)
export const DOCUMENTDB_SUPPORTED_PLATFORMS = FERRETDB_V2_SUPPORTED_PLATFORMS

/**
 * Map Node.js platform/arch to hostdb platform key
 * @param version - Optional FerretDB version to determine platform support (v1 vs v2)
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
  version?: string,
): string | null {
  const key = `${platform}-${arch}`
  const platforms =
    version && isV1(version)
      ? FERRETDB_V1_SUPPORTED_PLATFORMS
      : FERRETDB_V2_SUPPORTED_PLATFORMS
  return platforms.has(key) ? key : null
}

/**
 * Check if the current platform supports FerretDB
 * @param version - Optional FerretDB version to determine platform support (v1 vs v2)
 */
export function isPlatformSupported(
  platform: Platform,
  arch: Arch,
  version?: string,
): boolean {
  const key = `${platform}-${arch}`
  const platforms =
    version && isV1(version)
      ? FERRETDB_V1_SUPPORTED_PLATFORMS
      : FERRETDB_V2_SUPPORTED_PLATFORMS
  return platforms.has(key)
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
  const hostdbPlatform = getHostdbPlatform(platform, arch, version)

  if (!hostdbPlatform) {
    const v1 = isV1(version)
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. FerretDB ${v1 ? 'v1' : 'v2'} is ${v1 ? 'not available on this platform' : 'only supported on macOS and Linux'}.`,
    )
  }

  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  // v1 binaries are published under the "ferretdb-v1" engine name in hostdb
  // v2 binaries use the standard "ferretdb" engine name
  const hostdbEngine = isV1(version) ? 'ferretdb-v1' : Engine.FerretDB

  return buildHostdbUrl(hostdbEngine, {
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
      `Unsupported platform: ${platform}-${arch}. FerretDB is only supported on macOS and Linux.`,
    )
  }

  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  // Use shared buildHostdbUrl with 'postgresql-documentdb' as the engine
  return buildHostdbUrl('postgresql-documentdb', {
    version: fullVersion,
    hostdbPlatform: key,
    extension: ext,
  })
}

/**
 * Get the combined binary URLs for FerretDB (proxy and backend)
 *
 * For v1: Returns only ferretdb URL (backend is plain PostgreSQL, managed separately)
 * For v2: Returns both ferretdb and documentdb URLs
 *
 * @param version - FerretDB version (major or full)
 * @param backendVersion - postgresql-documentdb version (e.g., "17-0.107.0"), used for v2 only
 * @param platform - Operating system
 * @param arch - Architecture
 * @returns Object with ferretdb URL and optional documentdb URL
 */
export function getBinaryUrls(
  version: string,
  backendVersion: string,
  platform: Platform,
  arch: Arch,
): { ferretdb: string; documentdb?: string } {
  // Validate platform supports this FerretDB version
  if (!isPlatformSupported(platform, arch, version)) {
    const v1 = isV1(version)
    throw new Error(
      `FerretDB ${v1 ? 'v1' : 'v2'} is not available on ${platform}-${arch}.\n` +
        (v1
          ? 'This platform is not supported.'
          : 'FerretDB v2 is only supported on macOS and Linux. Try v1 for Windows support.'),
    )
  }

  if (isV1(version)) {
    // v1: backend is plain PostgreSQL (managed by postgresqlBinaryManager)
    return {
      ferretdb: getFerretDBBinaryUrl(version, platform, arch),
    }
  }

  // v2: backend is postgresql-documentdb
  return {
    ferretdb: getFerretDBBinaryUrl(version, platform, arch),
    documentdb: getDocumentDBBinaryUrl(backendVersion, platform, arch),
  }
}
