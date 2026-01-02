/**
 * Redis binary detection module
 * Finds Redis binaries installed on the system (via Homebrew, apt, etc.)
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug } from '../../core/error-handler'

const execAsync = promisify(exec)

/**
 * Common Homebrew paths for Redis on macOS
 * Includes versioned formulas (redis@7, redis@6) for multi-version support
 */
const HOMEBREW_REDIS_PATHS = [
  // ARM64 (Apple Silicon) - versioned formulas first
  '/opt/homebrew/opt/redis@8/bin',
  '/opt/homebrew/opt/redis@7/bin',
  '/opt/homebrew/opt/redis@6/bin',
  '/opt/homebrew/opt/redis/bin',
  '/opt/homebrew/bin',
  // Intel - versioned formulas first
  '/usr/local/opt/redis@8/bin',
  '/usr/local/opt/redis@7/bin',
  '/usr/local/opt/redis@6/bin',
  '/usr/local/opt/redis/bin',
  '/usr/local/bin',
]

/**
 * Version-specific Homebrew paths for Redis
 * Used to find binaries for a specific major version
 */
const HOMEBREW_REDIS_VERSION_PATHS: Record<string, string[]> = {
  '8': [
    '/opt/homebrew/opt/redis@8/bin',
    '/opt/homebrew/opt/redis/bin', // Unversioned formula might be v8
    '/usr/local/opt/redis@8/bin',
    '/usr/local/opt/redis/bin',
  ],
  '7': [
    '/opt/homebrew/opt/redis@7/bin',
    '/opt/homebrew/opt/redis/bin', // Unversioned formula might be v7
    '/usr/local/opt/redis@7/bin',
    '/usr/local/opt/redis/bin',
  ],
  '6': [
    '/opt/homebrew/opt/redis@6/bin',
    '/opt/homebrew/opt/redis/bin', // Unversioned formula might be v6
    '/usr/local/opt/redis@6/bin',
    '/usr/local/opt/redis/bin',
  ],
}

/**
 * Common paths for iredis (enhanced Redis CLI)
 */
const IREDIS_PATHS = [
  '/opt/homebrew/bin/iredis',
  '/usr/local/bin/iredis',
]

/**
 * Find redis-server binary
 */
export async function getRedisServerPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('redis-server')
  if (cached && existsSync(cached)) return cached

  // Check Homebrew paths
  for (const dir of HOMEBREW_REDIS_PATHS) {
    const path = `${dir}/redis-server`
    if (existsSync(path)) {
      logDebug(`Found redis-server at Homebrew path: ${path}`)
      return path
    }
  }

  // Check system PATH
  const systemPath = await platformService.findToolPath('redis-server')
  if (systemPath) {
    logDebug(`Found redis-server in PATH: ${systemPath}`)
    return systemPath
  }

  return null
}

/**
 * Find redis-cli binary
 */
export async function getRedisCliPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('redis-cli')
  if (cached && existsSync(cached)) return cached

  // Check Homebrew paths
  for (const dir of HOMEBREW_REDIS_PATHS) {
    const path = `${dir}/redis-cli`
    if (existsSync(path)) {
      logDebug(`Found redis-cli at: ${path}`)
      return path
    }
  }

  // Check system PATH
  const systemPath = await platformService.findToolPath('redis-cli')
  if (systemPath) {
    logDebug(`Found redis-cli in PATH: ${systemPath}`)
    return systemPath
  }

  return null
}

/**
 * Find iredis (enhanced Redis CLI) binary
 */
export async function getIredisPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('iredis')
  if (cached && existsSync(cached)) return cached

  // Check common iredis paths
  for (const path of IREDIS_PATHS) {
    if (existsSync(path)) {
      logDebug(`Found iredis at: ${path}`)
      return path
    }
  }

  // Check system PATH
  const systemPath = await platformService.findToolPath('iredis')
  if (systemPath) {
    logDebug(`Found iredis in PATH: ${systemPath}`)
    return systemPath
  }

  return null
}

/**
 * Get Redis version from redis-server --version output
 * Example output: "Redis server v=7.2.4 sha=00000000:0 malloc=libc bits=64 build=..."
 */
export async function getRedisVersion(
  redisServerPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${redisServerPath}" --version`, {
      timeout: 5000,
    })
    // Parse version from "Redis server v=7.2.4" or "v=7.2.4"
    const match = stdout.match(/v=(\d+\.\d+\.\d+)/)
    if (match) {
      return match[1]
    }
    // Also try matching just version number pattern
    const altMatch = stdout.match(/(\d+\.\d+\.\d+)/)
    return altMatch ? altMatch[1] : null
  } catch (error) {
    logDebug(`Failed to get redis-server version: ${error}`)
    return null
  }
}

/**
 * Cache entry for version path lookups
 */
type VersionCacheEntry = {
  path: string | null // null means "not found"
  timestamp: number
}

/**
 * Cache of detected version -> binary path mappings
 * Entries include timestamp for TTL-based invalidation
 */
const versionPathCache: Record<string, VersionCacheEntry> = {}

/**
 * TTL for negative cache entries (version not found)
 * Positive entries are validated via existsSync, so they don't need TTL
 */
const NEGATIVE_CACHE_TTL_MS = 60_000 // 1 minute

/**
 * Clear the version path cache
 * Call this after installing new Redis versions to force re-detection
 */
export function clearVersionCache(): void {
  for (const key of Object.keys(versionPathCache)) {
    delete versionPathCache[key]
  }
  logDebug('Cleared Redis version path cache')
}

/**
 * Detect all installed Redis versions
 * Returns map of major version -> full version string
 * Also populates versionPathCache for later use
 */
export async function detectInstalledVersions(): Promise<
  Record<string, string>
> {
  const versions: Record<string, string> = {}

  // Check all Homebrew paths (including versioned formulas)
  const now = Date.now()
  for (const dir of HOMEBREW_REDIS_PATHS) {
    const redisServerPath = `${dir}/redis-server`
    if (existsSync(redisServerPath)) {
      const version = await getRedisVersion(redisServerPath)
      if (version) {
        const major = version.split('.')[0]
        // Only add if we haven't seen this major version yet
        // (prefer versioned formula paths over generic ones)
        if (!versions[major]) {
          versions[major] = version
          versionPathCache[major] = { path: dir, timestamp: now }
          logDebug(`Detected Redis ${version} at ${redisServerPath}`)
        }
      }
    }
  }

  // Also check default PATH redis-server
  const defaultRedis = await platformService.findToolPath('redis-server')
  if (defaultRedis && Object.keys(versions).length === 0) {
    const version = await getRedisVersion(defaultRedis)
    if (version) {
      const major = version.split('.')[0]
      versions[major] = version
      // Store the directory containing the binary
      const dir = defaultRedis.replace(/\/redis-server$/, '')
      versionPathCache[major] = { path: dir, timestamp: now }
    }
  }

  return versions
}

/**
 * Get the binary directory for a specific major version
 * Returns the path to the bin directory containing redis-server for that version
 */
export async function getBinaryPathForVersion(
  majorVersion: string,
): Promise<string | null> {
  const now = Date.now()

  // Check cache first
  if (majorVersion in versionPathCache) {
    const cached = versionPathCache[majorVersion]

    if (cached.path === null) {
      // Negative cache - check if TTL expired
      if (now - cached.timestamp < NEGATIVE_CACHE_TTL_MS) {
        // Still fresh, return cached "not found"
        return null
      }
      // TTL expired, clear and re-detect
      logDebug(`Negative cache expired for Redis ${majorVersion}, re-detecting`)
      delete versionPathCache[majorVersion]
    } else {
      // Positive cache - validate path still exists
      const cachedPath = `${cached.path}/redis-server`
      if (existsSync(cachedPath)) {
        return cached.path
      }
      // Cached path no longer valid, clear it and re-detect
      delete versionPathCache[majorVersion]
    }
  }

  // Re-detect versions to populate cache
  await detectInstalledVersions()

  // Check cache again
  const entry = versionPathCache[majorVersion]
  if (entry?.path) {
    return entry.path
  }

  // Fall back to checking version-specific paths
  const paths = HOMEBREW_REDIS_VERSION_PATHS[majorVersion] || HOMEBREW_REDIS_PATHS
  for (const dir of paths) {
    const redisServerPath = `${dir}/redis-server`
    if (existsSync(redisServerPath)) {
      const version = await getRedisVersion(redisServerPath)
      if (version && version.split('.')[0] === majorVersion) {
        versionPathCache[majorVersion] = { path: dir, timestamp: now }
        return dir
      }
    }
  }

  // Cache the negative result to avoid repeated detection
  versionPathCache[majorVersion] = { path: null, timestamp: now }
  logDebug(`Redis version ${majorVersion} not found, cached negative result`)

  return null
}

/**
 * Get redis-server path for a specific version
 */
export async function getRedisServerPathForVersion(
  majorVersion: string,
): Promise<string | null> {
  const binDir = await getBinaryPathForVersion(majorVersion)
  if (binDir) {
    const serverPath = `${binDir}/redis-server`
    if (existsSync(serverPath)) {
      return serverPath
    }
  }
  return null
}

/**
 * Get redis-cli path for a specific version
 */
export async function getRedisCliPathForVersion(
  majorVersion: string,
): Promise<string | null> {
  const binDir = await getBinaryPathForVersion(majorVersion)
  if (binDir) {
    const cliPath = `${binDir}/redis-cli`
    if (existsSync(cliPath)) {
      return cliPath
    }
  }
  // Fall back to generic redis-cli (it's usually compatible across versions)
  return getRedisCliPath()
}

/**
 * Get installation instructions for Redis
 */
export function getInstallInstructions(): string {
  const { platform } = platformService.getPlatformInfo()

  switch (platform) {
    case 'darwin':
      return `Redis is not installed. Install with Homebrew:
  brew install redis

To start Redis as a service:
  brew services start redis

For the enhanced CLI (iredis):
  brew install iredis`

    case 'linux':
      return `Redis is not installed. Install with your package manager:
  Ubuntu/Debian: sudo apt install redis-server redis-tools
  CentOS/RHEL: sudo yum install redis
  Fedora: sudo dnf install redis
  Arch: sudo pacman -S redis

For the enhanced CLI (iredis):
  pip install iredis`

    case 'win32':
      return `Redis is not installed. Install with Chocolatey:
  choco install redis

Or using winget:
  winget install tporadowski.redis

Or using Scoop:
  scoop install redis

Note: Redis on Windows is community-maintained and may have limitations.
Consider using Windows Subsystem for Linux (WSL) for better Redis support.`

    default:
      return 'Redis is not installed. Visit https://redis.io/download'
  }
}
