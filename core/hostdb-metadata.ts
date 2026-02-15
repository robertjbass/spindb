/**
 * Fetches metadata from hostdb (databases.json and downloads.json)
 * to understand what tools each engine needs and how to install them.
 *
 * Primary registry: registry.layerbase.host
 * Fallback registry: GitHub raw (robertjbass/hostdb)
 *
 * Architecture:
 * - databases.json: Lists server, client, utilities, and enhanced CLI tools for each engine
 * - downloads.json: Provides package manager commands for installing tools
 */

import { logDebug } from './error-handler'
import { LAYERBASE_REGISTRY_BASE } from './hostdb-client'
import type { Engine } from '../types'

const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/robertjbass/hostdb/main'

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

type CliTools = {
  server: string | null
  client: string | null
  utilities: string[]
  enhanced: string[]
}

export type VersionEntryObject = {
  enabled?: boolean
  platforms?: string[]
  dependencies?: Array<{
    database: string
    cascadeDelete: boolean
    note?: string
  }>
  cliTools?: CliTools
}

type DatabaseEntry = {
  displayName: string
  cliTools: CliTools
  versions: Record<string, boolean | VersionEntryObject>
  platforms?: string[]
  dependencies?: Array<{
    database: string
    cascadeDelete: boolean
    note?: string
  }>
  spindbStatus?: string
  hostedServiceAllowed?: boolean
}

type PackageManagerDef = {
  name: string
  platforms: string[]
  installCmd: string
  checkCmd: string
}

type ToolPackageInfo = {
  package: string
  tap?: string // Homebrew tap
  repo?: string // apt repository
}

type ToolDownloadInfo = {
  packages?: {
    brew?: ToolPackageInfo
    apt?: ToolPackageInfo
    yum?: ToolPackageInfo
    dnf?: ToolPackageInfo
    choco?: ToolPackageInfo
  }
}

// databases.json is keyed directly by engine name
type DatabasesJson = Record<string, DatabaseEntry>

type DownloadsJson = {
  packageManagers: Record<string, PackageManagerDef>
  tools: Record<string, ToolDownloadInfo>
}

// Simple in-memory cache
let databasesCache: { data: DatabasesJson; timestamp: number } | null = null
let downloadsCache: { data: DownloadsJson; timestamp: number } | null = null

// In-flight request deduplication to prevent parallel fetches for the same URL
const inFlightRequests = new Map<string, Promise<unknown>>()

async function fetchWithCache<T>(
  urls: string[],
  getCache: () => { data: T; timestamp: number } | null,
  setCache: (cache: { data: T; timestamp: number }) => void,
): Promise<T> {
  // Use getter to always check the freshest cache state
  const cache = getCache()
  const now = Date.now()
  if (cache && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.data
  }

  // Check for in-flight request using the primary URL as key
  const cacheKey = urls[0]
  const inFlight = inFlightRequests.get(cacheKey)
  if (inFlight) {
    return inFlight as Promise<T>
  }

  // Create the fetch promise — try each URL in order
  const fetchPromise = (async () => {
    try {
      let lastError: Error | null = null
      for (const url of urls) {
        try {
          const response = await fetch(url)
          if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: ${response.status}`)
          }

          const data = (await response.json()) as T
          setCache({ data, timestamp: Date.now() })
          return data
        } catch (error) {
          lastError = error as Error
          logDebug(`Metadata fetch from ${url} failed: ${lastError.message}`)
        }
      }
      throw lastError ?? new Error('All metadata URLs failed')
    } finally {
      inFlightRequests.delete(cacheKey)
    }
  })()

  inFlightRequests.set(cacheKey, fetchPromise)
  return fetchPromise
}

export async function fetchDatabasesJson(): Promise<DatabasesJson> {
  return fetchWithCache(
    [
      `${LAYERBASE_REGISTRY_BASE}/databases.json`,
      `${GITHUB_RAW_BASE}/databases.json`,
    ],
    () => databasesCache,
    (c) => {
      databasesCache = c
    },
  )
}

export async function fetchDownloadsJson(): Promise<DownloadsJson> {
  return fetchWithCache(
    [
      `${LAYERBASE_REGISTRY_BASE}/downloads.json`,
      `${GITHUB_RAW_BASE}/downloads.json`,
    ],
    () => downloadsCache,
    (c) => {
      downloadsCache = c
    },
  )
}

/**
 * Get the CLI tools definition for a database engine
 * @param engine Engine (e.g., Engine.PostgreSQL or 'postgresql')
 */
export async function getDatabaseTools(
  engine: Engine | string,
): Promise<CliTools | null> {
  try {
    const data = await fetchDatabasesJson()
    // hostdb uses lowercase engine names
    const key = engine.toLowerCase()
    const entry = data[key]
    return entry?.cliTools || null
  } catch (error) {
    logDebug('Failed to fetch database tools from hostdb', {
      engine,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Get the client tools required for a database engine
 * Returns an array of tool names (client + utilities)
 */
export async function getRequiredClientTools(
  engine: Engine | string,
): Promise<string[]> {
  const cliTools = await getDatabaseTools(engine)
  if (!cliTools) return []

  const required: string[] = []
  if (cliTools.client) {
    required.push(cliTools.client)
  }
  if (cliTools.utilities) {
    required.push(...cliTools.utilities)
  }
  return required
}

/**
 * Get package manager info for a specific tool
 * @param tool Tool name (e.g., 'psql', 'mysqldump')
 */
export async function getToolPackageInfo(
  tool: string,
): Promise<ToolDownloadInfo | null> {
  try {
    const data = await fetchDownloadsJson()
    return data.tools[tool] || null
  } catch (error) {
    logDebug('Failed to fetch tool package info from hostdb', {
      tool,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Get the install command for a tool using a specific package manager
 * @param tool Tool name (e.g., 'psql', 'pg_dump')
 * @param packageManager Package manager key (e.g., 'brew', 'apt')
 * @returns The full install command, or null if not available
 */
export async function getInstallCommand(
  tool: string,
  packageManager: 'brew' | 'apt' | 'yum' | 'dnf' | 'choco',
): Promise<string | null> {
  try {
    const data = await fetchDownloadsJson()

    // Get the package manager definition
    const pmDef = data.packageManagers[packageManager]
    if (!pmDef) return null

    // Get the tool's package info for this package manager
    const toolInfo = data.tools[tool]
    if (!toolInfo?.packages?.[packageManager]) return null

    const pkgInfo = toolInfo.packages[packageManager]

    // Build the command
    let cmd = pmDef.installCmd.replace('{package}', pkgInfo.package)

    // Handle Homebrew taps
    if (packageManager === 'brew' && pkgInfo.tap) {
      cmd = `brew tap ${pkgInfo.tap} && ${cmd}`
    }

    return cmd
  } catch (error) {
    logDebug('Failed to get install command from hostdb', {
      tool,
      packageManager,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Get the package to install that provides a set of tools
 * For many tools, a single package provides multiple binaries (e.g., postgresql provides psql, pg_dump, etc.)
 * This returns the unique packages needed to install all the requested tools
 */
export async function getPackagesForTools(
  tools: string[],
  packageManager: 'brew' | 'apt' | 'yum' | 'dnf' | 'choco',
): Promise<Array<{ package: string; tap?: string; tools: string[] }>> {
  try {
    const data = await fetchDownloadsJson()
    const packageMap = new Map<string, { tap?: string; tools: string[] }>()

    for (const tool of tools) {
      const toolInfo = data.tools[tool]
      if (!toolInfo?.packages?.[packageManager]) continue

      const pkgInfo = toolInfo.packages[packageManager]
      const key = pkgInfo.package

      const existing = packageMap.get(key)
      if (existing) {
        existing.tools.push(tool)
      } else {
        packageMap.set(key, {
          tap: pkgInfo.tap,
          tools: [tool],
        })
      }
    }

    return Array.from(packageMap.entries()).map(([pkg, info]) => ({
      package: pkg,
      tap: info.tap,
      tools: info.tools,
    }))
  } catch (error) {
    logDebug('Failed to get packages for tools from hostdb', {
      tools,
      packageManager,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Check if a version entry is enabled.
 * Handles both old schema (boolean) and new schema (object with optional enabled field).
 * Objects are enabled by default unless explicitly `{ enabled: false }`.
 */
export function isVersionEnabled(value: boolean | VersionEntryObject): boolean {
  if (typeof value === 'boolean') return value
  return value.enabled !== false
}

/**
 * Get available versions for a database engine from databases.json
 * This is the authoritative source for what versions are actually available in hostdb.
 * @param engine Engine (e.g., Engine.PostgreSQL or 'postgresql')
 * @returns Array of available version strings, or null if fetch fails
 */
export async function getAvailableVersions(
  engine: Engine | string,
): Promise<string[] | null> {
  try {
    const data = await fetchDatabasesJson()
    const key = engine.toLowerCase()
    const entry = data[key]
    if (!entry?.versions) return null

    return Object.entries(entry.versions)
      .filter(([, value]) => isVersionEnabled(value))
      .map(([version]) => version)
  } catch (error) {
    logDebug('Failed to fetch available versions from hostdb', {
      engine,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
