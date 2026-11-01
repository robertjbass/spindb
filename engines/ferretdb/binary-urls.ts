/**
 * FerretDB binary URL generation for hostdb
 *
 * Generates download URLs for FerretDB binaries from the hostdb GitHub releases.
 *
 * FerretDB v2 requires two binaries:
 * - ferretdb: MongoDB-compatible proxy
 * - postgresql-documentdb: PostgreSQL 17 + DocumentDB extension
 *
 * FerretDB v1 requires:
 * - ferretdb: MongoDB-compatible proxy
 * - Plain PostgreSQL (managed by postgresqlBinaryManager, not downloaded here)
 *
 * Both v1 and v2 use the same "ferretdb" hostdb engine name.
 * v1 supports all platforms including Windows.
 * v2 is macOS/Linux only (postgresql-documentdb has Windows startup issues).
 */

import { getDatabaseEntry } from 'hostdb'
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

type DocumentDBEntry = ReturnType<typeof getDatabaseEntry>

/**
 * Whether hostdb has a postgresql-documentdb archive for this version and
 * platform: listed in the version's (or else the engine's) platforms, or
 * retired (a retired platform's published archive stays downloadable).
 * Without an entry for the version, fall back to the platform set above.
 *
 * hostdb stopped building darwin-x64 (Intel Mac) DocumentDB on 2026-11-01,
 * so a version released after that has no Intel archive at all.
 */
export function isDocumentDBBuiltForPlatform(
  version: string,
  platformKey: string,
  entry: DocumentDBEntry = getDatabaseEntry('postgresql-documentdb'),
): boolean {
  const versionEntry = entry?.versions?.[version]
  if (!entry || !versionEntry) return true
  const config = typeof versionEntry === 'object' ? versionEntry : {}
  const versionPlatforms = config.platforms
    ? Array.isArray(config.platforms)
      ? config.platforms
      : Object.keys(config.platforms)
    : []
  const platforms: string[] =
    versionPlatforms.length > 0 ? versionPlatforms : entry.platforms
  return (
    platforms.includes(platformKey) ||
    Object.keys(config.retiredPlatforms ?? {}).includes(platformKey)
  )
}

/**
 * Throw an actionable error when hostdb has no postgresql-documentdb archive
 * for this version and platform, instead of letting the download 404.
 */
export function assertDocumentDBBuiltForPlatform(
  version: string,
  platformKey: string,
  entry: DocumentDBEntry = getDatabaseEntry('postgresql-documentdb'),
): void {
  if (isDocumentDBBuiltForPlatform(version, platformKey, entry)) return
  if (platformKey === 'darwin-x64') {
    throw new Error(
      `FerretDB v2 is not supported on Intel Macs: its PostgreSQL-DocumentDB backend (${version}) is built for Apple Silicon (macOS 15 or newer) and Linux only. ` +
        'Use FerretDB v1 (`--db-version 1`), which runs on plain PostgreSQL, or run FerretDB v2 on an Apple Silicon Mac or Linux.',
    )
  }
  throw new Error(
    `postgresql-documentdb ${version} (FerretDB v2 backend) is not built for ${platformKey}.`,
  )
}

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
  return getHostdbPlatform(platform, arch, version) !== null
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
      `Unsupported platform: ${platform}-${arch}. postgresql-documentdb (FerretDB v2 backend) is only supported on macOS and Linux.`,
    )
  }

  assertDocumentDBBuiltForPlatform(fullVersion, key)

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
