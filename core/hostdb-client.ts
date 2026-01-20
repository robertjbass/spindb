/**
 * Shared hostdb Client Module
 *
 * Provides centralized access to the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built database binaries for multiple platforms.
 * This module handles fetching releases.json with caching to avoid
 * repeated network requests.
 */

import { Platform, type Arch, type Engine } from '../types'

// Platform definition in hostdb releases.json
export type HostdbPlatform = {
  url: string
  sha256: string
  size: number
}

// Version entry in hostdb releases.json
export type HostdbRelease = {
  version: string
  releaseTag: string
  releasedAt: string
  platforms: Record<string, HostdbPlatform>
}

// Structure of hostdb releases.json
export type HostdbReleasesData = {
  repository: string
  updatedAt: string
  databases: Record<string, Record<string, HostdbRelease>>
}

// Supported hostdb platforms
export const SUPPORTED_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
] as const

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number]

// Type alias for engines available in hostdb (uses the Engine enum from types)
export type HostdbEngine = Engine

/**
 * In-memory cache for fetched releases.
 *
 * THREAD-SAFETY NOTE: This cache uses module-level mutable state and is NOT
 * safe for use across Node.js worker threads. Each worker thread will have
 * its own copy of this cache. For SpinDB's single-threaded CLI use case,
 * this is acceptable.
 */
let cachedReleases: HostdbReleasesData | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

const HOSTDB_RELEASES_URL =
  'https://raw.githubusercontent.com/robertjbass/hostdb/main/releases.json'

/**
 * Clear the releases cache (for testing).
 *
 * NOTE: This only clears the cache in the current thread/process.
 * If using worker threads, each worker has its own cache instance.
 */
export function clearCache(): void {
  cachedReleases = null
  cacheTimestamp = 0
}

/**
 * Fetch releases.json from hostdb repository with caching.
 *
 * @returns The full releases data from hostdb
 * @throws Error if the fetch fails
 */
export async function fetchHostdbReleases(): Promise<HostdbReleasesData> {
  // Return cached releases if still valid
  if (cachedReleases && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedReleases
  }

  try {
    const response = await fetch(HOSTDB_RELEASES_URL, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as HostdbReleasesData

    // Cache the results
    cachedReleases = data
    cacheTimestamp = Date.now()

    return data
  } catch (error) {
    const err = error as Error
    // Log the failure and rethrow - caller decides whether to use fallback
    console.warn(`Warning: Failed to fetch hostdb releases: ${err.message}`)
    throw error
  }
}

/**
 * Get the releases for a specific engine from the hostdb data.
 *
 * @param data - The full hostdb releases data
 * @param engine - The engine (e.g., Engine.PostgreSQL or 'postgresql')
 * @returns The releases for that engine, or undefined if not found
 */
export function getEngineReleases(
  data: HostdbReleasesData,
  engine: Engine | string,
): Record<string, HostdbRelease> | undefined {
  return data.databases[engine]
}

/**
 * Map Node.js platform identifiers to hostdb platform identifiers.
 *
 * @param platform - Node.js platform (e.g., Platform.Darwin)
 * @param arch - Node.js architecture (e.g., Arch.ARM64)
 * @returns The hostdb platform identifier, or undefined if not supported
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): SupportedPlatform | undefined {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.includes(key as SupportedPlatform)
    ? (key as SupportedPlatform)
    : undefined
}

/**
 * Validate that a platform is supported by hostdb.
 *
 * @param platform - Node.js platform (e.g., Platform.Darwin)
 * @param arch - Node.js architecture (e.g., Arch.ARM64)
 * @returns The validated hostdb platform identifier
 * @throws Error if the platform is not supported
 */
export function validatePlatform(
  platform: Platform,
  arch: Arch,
): SupportedPlatform {
  const hostdbPlatform = getHostdbPlatform(platform, arch)
  if (!hostdbPlatform) {
    const supported = SUPPORTED_PLATFORMS.join(', ')
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. ` +
        `hostdb provides binaries for: ${supported}`,
    )
  }
  return hostdbPlatform
}

export type BuildDownloadUrlOptions = {
  version: string
  platform: Platform
  arch: Arch
}

/**
 * Build a download URL for a hostdb release.
 *
 * @param engine - The engine name (e.g., 'postgresql', 'mysql')
 * @param options - Version and platform configuration
 * @returns The download URL
 * @throws Error if the platform is not supported by hostdb
 */
export function buildDownloadUrl(
  engine: Engine | string,
  options: BuildDownloadUrlOptions,
): string {
  const { version, platform, arch } = options
  const hostdbPlatform = validatePlatform(platform, arch)
  const tag = `${engine}-${version}`
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'
  const filename = `${engine}-${version}-${hostdbPlatform}.${ext}`

  return `https://github.com/robertjbass/hostdb/releases/download/${tag}/${filename}`
}
