import { platform, arch } from 'os'
import { defaults } from '@/config/defaults'

/**
 * Fallback map of major versions to stable patch versions
 * Used when Maven repository is unreachable
 */
export const FALLBACK_VERSION_MAP: Record<string, string> = {
  '14': '14.20.0',
  '15': '15.15.0',
  '16': '16.11.0',
  '17': '17.7.0',
}

/**
 * Supported major versions (in order of display)
 */
export const SUPPORTED_MAJOR_VERSIONS = ['14', '15', '16', '17']

// Cache for fetched versions
let cachedVersions: Record<string, string[]> | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Fetch available versions from Maven repository
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Return cached versions if still valid
  if (cachedVersions && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedVersions
  }

  const zonkyPlatform = getZonkyPlatform(platform(), arch())
  if (!zonkyPlatform) {
    throw new Error(`Unsupported platform: ${platform()}-${arch()}`)
  }

  const url = `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${zonkyPlatform}/`

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const html = await response.text()

    // Parse version directories from the HTML listing
    // Format: <a href="14.15.0/">14.15.0/</a>
    const versionRegex = /href="(\d+\.\d+\.\d+)\/"/g
    const versions: string[] = []
    let match

    while ((match = versionRegex.exec(html)) !== null) {
      versions.push(match[1])
    }

    // Group versions by major version
    const grouped: Record<string, string[]> = {}
    for (const major of SUPPORTED_MAJOR_VERSIONS) {
      grouped[major] = versions
        .filter((v) => v.startsWith(`${major}.`))
        .sort((a, b) => compareVersions(b, a)) // Sort descending (latest first)
    }

    // Cache the results
    cachedVersions = grouped
    cacheTimestamp = Date.now()

    return grouped
  } catch {
    // Return fallback on any error
    return getFallbackVersions()
  }
}

/**
 * Get fallback versions when network is unavailable
 */
function getFallbackVersions(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const major of SUPPORTED_MAJOR_VERSIONS) {
    grouped[major] = [FALLBACK_VERSION_MAP[major]]
  }
  return grouped
}

/**
 * Compare two version strings (e.g., "16.11.0" vs "16.9.0")
 * Returns positive if a > b, negative if a < b, 0 if equal
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA !== numB) {
      return numA - numB
    }
  }
  return 0
}

/**
 * Get the latest version for a major version
 */
export async function getLatestVersion(major: string): Promise<string> {
  const versions = await fetchAvailableVersions()
  const majorVersions = versions[major]
  if (majorVersions && majorVersions.length > 0) {
    return majorVersions[0] // First is latest due to descending sort
  }
  return FALLBACK_VERSION_MAP[major] || `${major}.0.0`
}

// Legacy export for backward compatibility
export const VERSION_MAP = FALLBACK_VERSION_MAP

/**
 * Get the zonky.io platform identifier
 */
export function getZonkyPlatform(
  platform: string,
  arch: string,
): string | undefined {
  const key = `${platform}-${arch}`
  return defaults.platformMappings[key]
}

/**
 * Build the download URL for PostgreSQL binaries from zonky.io
 */
export function getBinaryUrl(
  version: string,
  platform: string,
  arch: string,
): string {
  const zonkyPlatform = getZonkyPlatform(platform, arch)
  if (!zonkyPlatform) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`)
  }

  // Use VERSION_MAP for major versions, otherwise treat as full version
  const fullVersion = VERSION_MAP[version] || normalizeVersion(version)

  return `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${zonkyPlatform}/${fullVersion}/embedded-postgres-binaries-${zonkyPlatform}-${fullVersion}.jar`
}

/**
 * Normalize version string to X.Y.Z format
 */
function normalizeVersion(version: string): string {
  const parts = version.split('.')
  if (parts.length === 2) {
    return `${version}.0`
  }
  return version
}

/**
 * Get the full version string for a major version
 */
export function getFullVersion(majorVersion: string): string | null {
  return VERSION_MAP[majorVersion] || null
}
