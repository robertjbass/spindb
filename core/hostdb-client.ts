/**
 * Shared hostdb Client Module
 *
 * Provides centralized access to pre-built database binaries.
 * Primary registry: registry.layerbase.host
 * Fallback registry: GitHub releases (robertjbass/hostdb)
 *
 * This module handles fetching releases.json with caching to avoid
 * repeated network requests.
 */

import { Platform, type Arch, type Engine } from '../types'
import { logDebug } from './error-handler'

// Registry base URLs
export const LAYERBASE_REGISTRY_BASE = 'https://registry.layerbase.host'
export const GITHUB_REGISTRY_BASE =
  'https://github.com/robertjbass/hostdb/releases/download'

/**
 * Toggle GitHub fallback for binary downloads and releases.json fetches.
 * Set to `false` to exclusively test the Layerbase registry.
 * Must be re-enabled before release (see PRE_RELEASE_TASKS.md).
 */
export const ENABLE_GITHUB_FALLBACK = false

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
  deprecated?: boolean
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

export const LAYERBASE_RELEASES_URL =
  'https://registry.layerbase.host/releases.json'
export const GITHUB_RELEASES_URL =
  'https://raw.githubusercontent.com/robertjbass/hostdb/main/releases.json'

/**
 * Get the list of releases.json URLs to try, respecting ENABLE_GITHUB_FALLBACK.
 * When fallback is disabled, only the Layerbase URL is returned.
 */
export function getReleasesUrls(): string[] {
  return ENABLE_GITHUB_FALLBACK
    ? [LAYERBASE_RELEASES_URL, GITHUB_RELEASES_URL]
    : [LAYERBASE_RELEASES_URL]
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

  // Try layerbase registry first, fall back to GitHub (if enabled)
  const urls = getReleasesUrls()
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const isLast = i === urls.length - 1
    try {
      const response = await fetch(url, {
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
      logDebug(`Failed to fetch releases from ${url}: ${err.message}`)
      // If this was the last URL, rethrow
      if (isLast) {
        throw error
      }
      // Otherwise try the next URL
    }
  }

  // Should be unreachable (loop always throws on last iteration)
  throw new Error('Failed to fetch hostdb releases from all registries')
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

export type BuildHostdbUrlOptions = {
  version: string
  hostdbPlatform: string
  extension?: 'tar.gz' | 'zip'
}

/**
 * Build a download URL for a hostdb release (low-level, no validation).
 *
 * This is the core URL builder that all engines should use after validating
 * the platform against their own supported platform set.
 *
 * @param engine - The engine name (e.g., 'postgresql', 'mysql')
 * @param options - Version, pre-validated platform string, and optional extension
 * @returns The download URL
 */
export function buildHostdbUrl(
  engine: Engine | string,
  options: BuildHostdbUrlOptions,
): string {
  const { version, hostdbPlatform, extension = 'tar.gz' } = options
  const tag = `${engine}-${version}`
  const filename = `${engine}-${version}-${hostdbPlatform}.${extension}`

  return `${LAYERBASE_REGISTRY_BASE}/${tag}/${filename}`
}

/**
 * Build a GitHub fallback URL for a hostdb release (same path scheme as layerbase).
 */
export function buildGithubFallbackUrl(
  engine: Engine | string,
  options: BuildHostdbUrlOptions,
): string {
  const { version, hostdbPlatform, extension = 'tar.gz' } = options
  const tag = `${engine}-${version}`
  const filename = `${engine}-${version}-${hostdbPlatform}.${extension}`

  return `${GITHUB_REGISTRY_BASE}/${tag}/${filename}`
}

/**
 * Convert a layerbase registry URL to its GitHub fallback equivalent.
 * Returns null if the URL is not a layerbase URL or if GitHub fallback is disabled.
 */
export function getRegistryFallbackUrl(url: string): string | null {
  if (!ENABLE_GITHUB_FALLBACK) return null
  if (url.startsWith(LAYERBASE_REGISTRY_BASE)) {
    return url.replace(LAYERBASE_REGISTRY_BASE, GITHUB_REGISTRY_BASE)
  }
  return null
}

// Retry policy for transient network failures. Picked so a 1-2s blip
// gets absorbed but a real outage fails quickly. Total worst-case
// budget per URL = sum of delays = 0 + 300 + 900 = 1.2s of backoff
// across 3 attempts.
const TRANSIENT_RETRY_DELAYS_MS = [0, 300, 900]

/**
 * Returns true when an error from `fetch` looks like a transient
 * network problem worth retrying. Excludes intentional timeouts
 * (AbortError, which carry their own meaning) and non-retryable
 * client errors at this layer.
 *
 * Node's undici throws `TypeError: fetch failed` for almost every
 * connection-level failure; the underlying reason lives in
 * `error.cause.code` (e.g., 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
 * 'UND_ERR_SOCKET'). Treating all of those as transient is the right
 * call — none of them indicate the URL is permanently broken.
 */
function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return false
  if (error.message === 'fetch failed') return true
  const cause = (error as { cause?: { code?: string } }).cause
  if (cause?.code) {
    return [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
    ].includes(cause.code)
  }
  return false
}

/**
 * Returns true when an HTTP response status code is worth retrying.
 * Covers transient server-side conditions (5xx) and rate limiting
 * (429). Client errors (other 4xx) are NOT retried — they won't
 * change on retry and are usually a bug in the request.
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch a URL with retry on transient network errors and transient
 * HTTP responses (5xx, 408, 429). Used as the base primitive that
 * fetchWithRegistryFallback and fetchFromRegistryUrls build on, so a
 * single network blip doesn't take down a binary download. Honors
 * AbortError so caller-supplied timeouts still terminate immediately.
 */
async function fetchWithRetries(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  let lastError: unknown
  let lastStatus: number | null = null
  for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt])
    try {
      const response = await fetch(url, options)
      if (response.ok || !isTransientStatus(response.status)) {
        return response
      }
      lastStatus = response.status
      logDebug(
        `Fetch ${url} returned ${response.status} on attempt ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length}, retrying...`,
      )
    } catch (error) {
      if (!isTransientFetchError(error)) {
        throw error
      }
      lastError = error
      logDebug(
        `Fetch ${url} failed transiently on attempt ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length}: ${(error as Error).message}`,
      )
    }
  }
  // All attempts exhausted. Throw the last error we saw, or a
  // synthetic one carrying the last HTTP status if we never threw.
  if (lastError) throw lastError
  throw new Error(
    `fetch ${url} failed after ${TRANSIENT_RETRY_DELAYS_MS.length} attempts (last status: ${lastStatus ?? 'unknown'})`,
  )
}

/**
 * Fetch wrapper that tries the primary URL first, then falls back to the
 * GitHub registry if the primary is a layerbase URL and the request fails
 * with a 404, 5xx, or network error.
 *
 * Each URL attempt internally retries on transient errors before falling
 * back to the next URL — a single network blip won't burn through the
 * fallback. AbortError (timeout) still propagates immediately.
 */
export async function fetchWithRegistryFallback(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  try {
    const response = await fetchWithRetries(url, options)
    if (response.status === 404 || response.status >= 500) {
      const fallbackUrl = getRegistryFallbackUrl(url)
      if (fallbackUrl) {
        logDebug(
          `Primary registry returned ${response.status}, trying GitHub fallback`,
        )
        return await fetchWithRetries(fallbackUrl, options)
      }
    }
    return response
  } catch (error) {
    const err = error as Error
    // Never retry on timeout (AbortError)
    if (err.name === 'AbortError') {
      throw error
    }
    const fallbackUrl = getRegistryFallbackUrl(url)
    if (fallbackUrl) {
      logDebug(
        `Primary registry fetch failed (${err.message}), trying GitHub fallback`,
      )
      return await fetchWithRetries(fallbackUrl, options)
    }
    throw error
  }
}

/**
 * Try fetching from multiple registry URLs in order, returning the first
 * successful (response.ok) Response. Each URL gets its own retry budget
 * before moving on to the next so transient blips don't burn through the
 * registry list. Logs per-URL failures via the supplied logger callback.
 *
 * @param urls - URLs to try in order (e.g., layerbase then GitHub)
 * @param logger - Callback for logging per-URL failures
 * @param timeoutMs - Per-request timeout in milliseconds (default: 5000)
 * @returns The first successful Response
 * @throws Error if all URLs fail
 */
export async function fetchFromRegistryUrls(
  urls: string[],
  logger: (message: string) => void,
  timeoutMs: number = 5000,
): Promise<Response> {
  let lastError: Error | null = null
  for (const url of urls) {
    try {
      const response = await fetchWithRetries(url, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok) return response
      logger(`Registry fetch from ${url}: HTTP ${response.status}`)
    } catch (error) {
      logger(`Registry fetch from ${url} failed: ${error}`)
      lastError = error as Error
    }
  }
  throw lastError ?? new Error('All release registries failed')
}

export type BuildDownloadUrlOptions = {
  version: string
  platform: Platform
  arch: Arch
}

/**
 * Build a download URL for a hostdb release with platform validation.
 *
 * This is a convenience wrapper around buildHostdbUrl that validates
 * the platform against the global SUPPORTED_PLATFORMS list. For engines
 * with different platform support (e.g., ClickHouse doesn't support Windows),
 * use buildHostdbUrl directly after validating against engine-specific platforms.
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
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(engine, { version, hostdbPlatform, extension: ext })
}
