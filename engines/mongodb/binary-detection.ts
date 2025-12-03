/**
 * MongoDB binary detection and management
 *
 * Unlike PostgreSQL (which downloads binaries), MongoDB uses system-installed binaries.
 * This module detects mongod, mongosh, mongodump, and mongorestore on the system.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import type { BinaryConfig, BinaryTool } from '../../types'

const execAsync = promisify(exec)

/**
 * MongoDB binary names we need to detect
 */
export type MongoDBBinary = 'mongod' | 'mongosh' | 'mongodump' | 'mongorestore'

/**
 * Result of binary detection
 */
export type BinaryDetectionResult = {
  found: boolean
  path?: string
  version?: string
  error?: string
}

/**
 * Common MongoDB installation paths on different platforms
 */
const MONGODB_SEARCH_PATHS = {
  darwin: [
    // Homebrew ARM (Apple Silicon)
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/mongodb-community/bin',
    '/opt/homebrew/opt/mongodb-database-tools/bin',
    // Homebrew Intel
    '/usr/local/bin',
    '/usr/local/opt/mongodb-community/bin',
    '/usr/local/opt/mongodb-database-tools/bin',
  ],
  linux: [
    '/usr/bin',
    '/usr/local/bin',
    // MongoDB official packages
    '/usr/local/mongodb/bin',
  ],
}

/**
 * Check if a binary exists at a specific path
 */
async function checkBinaryPath(path: string): Promise<boolean> {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * Find binary in system PATH
 */
async function findInPath(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(`which ${binary}`)
    const path = stdout.trim()
    if (path && existsSync(path)) {
      return path
    }
  } catch {
    // Binary not found in PATH
  }
  return undefined
}

/**
 * Search for binary in common installation directories
 */
async function searchCommonPaths(
  binary: string,
  platform: 'darwin' | 'linux',
): Promise<string | undefined> {
  const searchPaths = MONGODB_SEARCH_PATHS[platform] || []

  for (const dir of searchPaths) {
    const fullPath = `${dir}/${binary}`
    if (await checkBinaryPath(fullPath)) {
      return fullPath
    }
  }

  return undefined
}

/**
 * Get MongoDB server version from mongod binary
 */
async function getMongodVersion(mongodPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(`"${mongodPath}" --version`)
    // Output format: "db version v8.0.0" or similar
    const match = stdout.match(/db version v?(\d+\.\d+\.\d+)/)
    if (match) {
      return match[1]
    }
    // Try alternate format
    const altMatch = stdout.match(/v?(\d+\.\d+\.\d+)/)
    if (altMatch) {
      return altMatch[1]
    }
  } catch {
    // Version check failed
  }
  return undefined
}

/**
 * Get MongoDB shell version from mongosh binary
 */
async function getMongoshVersion(
  mongoshPath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(`"${mongoshPath}" --version`)
    // Output is just the version number, e.g., "2.1.0"
    const version = stdout.trim()
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return version.split('\n')[0].trim()
    }
  } catch {
    // Version check failed
  }
  return undefined
}

/**
 * Get MongoDB tools version from mongodump/mongorestore binary
 */
async function getToolsVersion(toolPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(`"${toolPath}" --version`)
    // Output format: "mongodump version: 100.9.0" or similar
    const match = stdout.match(/version[:\s]+(\d+\.\d+\.\d+)/)
    if (match) {
      return match[1]
    }
  } catch {
    // Version check failed
  }
  return undefined
}

/**
 * Detect a specific MongoDB binary
 */
export async function detectBinary(
  binary: MongoDBBinary,
): Promise<BinaryDetectionResult> {
  const platform = process.platform as 'darwin' | 'linux'

  // First, try to find in PATH
  let binaryPath = await findInPath(binary)

  // If not found in PATH, search common installation directories
  if (!binaryPath && (platform === 'darwin' || platform === 'linux')) {
    binaryPath = await searchCommonPaths(binary, platform)
  }

  if (!binaryPath) {
    return {
      found: false,
      error: `${binary} not found. Install MongoDB: brew install mongodb-community (macOS) or see https://www.mongodb.com/docs/manual/installation/`,
    }
  }

  // Get version
  let version: string | undefined
  if (binary === 'mongod') {
    version = await getMongodVersion(binaryPath)
  } else if (binary === 'mongosh') {
    version = await getMongoshVersion(binaryPath)
  } else {
    version = await getToolsVersion(binaryPath)
  }

  return {
    found: true,
    path: binaryPath,
    version,
  }
}

/**
 * Detect all MongoDB binaries and cache results
 */
export async function detectAllBinaries(): Promise<
  Record<MongoDBBinary, BinaryDetectionResult>
> {
  const binaries: MongoDBBinary[] = [
    'mongod',
    'mongosh',
    'mongodump',
    'mongorestore',
  ]

  const results: Record<string, BinaryDetectionResult> = {}

  for (const binary of binaries) {
    results[binary] = await detectBinary(binary)
  }

  return results as Record<MongoDBBinary, BinaryDetectionResult>
}

/**
 * Get path to a MongoDB binary, with caching
 */
export async function getBinaryPath(
  binary: MongoDBBinary,
): Promise<string | undefined> {
  // Check config cache first
  const config = await configManager.get()
  const cached = config.binaries[binary as BinaryTool] as
    | BinaryConfig
    | undefined

  if (cached?.path && existsSync(cached.path)) {
    return cached.path
  }

  // Detect binary
  const result = await detectBinary(binary)

  if (result.found && result.path) {
    // Cache the result
    await configManager.setBinary(binary as BinaryTool, {
      tool: binary as BinaryTool,
      path: result.path,
      source: 'system',
      version: result.version,
    })

    return result.path
  }

  return undefined
}

/**
 * Check if all required MongoDB binaries are available
 */
export async function checkRequiredBinaries(): Promise<{
  allFound: boolean
  missing: MongoDBBinary[]
  details: Record<MongoDBBinary, BinaryDetectionResult>
}> {
  const required: MongoDBBinary[] = ['mongod', 'mongosh']
  const results = await detectAllBinaries()

  const missing = required.filter((binary) => !results[binary].found)

  return {
    allFound: missing.length === 0,
    missing,
    details: results,
  }
}

/**
 * Check if backup tools are available
 */
export async function checkBackupTools(): Promise<{
  available: boolean
  missing: MongoDBBinary[]
}> {
  const tools: MongoDBBinary[] = ['mongodump', 'mongorestore']
  const missing: MongoDBBinary[] = []

  for (const tool of tools) {
    const result = await detectBinary(tool)
    if (!result.found) {
      missing.push(tool)
    }
  }

  return {
    available: missing.length === 0,
    missing,
  }
}

/**
 * Refresh all binary paths in cache
 */
export async function refreshBinaryCache(): Promise<void> {
  const binaries: MongoDBBinary[] = [
    'mongod',
    'mongosh',
    'mongodump',
    'mongorestore',
  ]

  for (const binary of binaries) {
    const result = await detectBinary(binary)
    if (result.found && result.path) {
      await configManager.setBinary(binary as BinaryTool, {
        tool: binary as BinaryTool,
        path: result.path,
        source: 'system',
        version: result.version,
      })
    }
  }
}
