/**
 * MongoDB binary detection module
 * Finds MongoDB binaries installed on the system (via Homebrew, apt, etc.)
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug } from '../../core/error-handler'

const execAsync = promisify(exec)

/**
 * Common Homebrew paths for MongoDB on macOS
 * MongoDB uses mongodb-community formula with optional version suffix
 */
const HOMEBREW_MONGODB_PATHS = [
  // ARM64 (Apple Silicon)
  '/opt/homebrew/opt/mongodb-community/bin',
  '/opt/homebrew/opt/mongodb-community@8.0/bin',
  '/opt/homebrew/opt/mongodb-community@7.0/bin',
  '/opt/homebrew/opt/mongodb-community@6.0/bin',
  // Intel
  '/usr/local/opt/mongodb-community/bin',
  '/usr/local/opt/mongodb-community@8.0/bin',
  '/usr/local/opt/mongodb-community@7.0/bin',
  '/usr/local/opt/mongodb-community@6.0/bin',
]

/**
 * Common paths for mongosh (MongoDB Shell)
 * mongosh is often installed separately from the server
 */
const HOMEBREW_MONGOSH_PATHS = [
  '/opt/homebrew/bin/mongosh',
  '/usr/local/bin/mongosh',
]

/**
 * Common paths for MongoDB database tools (mongodump, mongorestore)
 */
const HOMEBREW_TOOLS_PATHS = [
  '/opt/homebrew/opt/mongodb-database-tools/bin',
  '/usr/local/opt/mongodb-database-tools/bin',
]

/**
 * Find mongod (MongoDB server) binary
 */
export async function getMongodPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('mongod')
  if (cached && existsSync(cached)) return cached

  // Check Homebrew paths
  for (const dir of HOMEBREW_MONGODB_PATHS) {
    const path = `${dir}/mongod`
    if (existsSync(path)) {
      logDebug(`Found mongod at Homebrew path: ${path}`)
      return path
    }
  }

  // Check system PATH
  const systemPath = await platformService.findToolPath('mongod')
  if (systemPath) {
    logDebug(`Found mongod in PATH: ${systemPath}`)
    return systemPath
  }

  return null
}

/**
 * Find mongosh (MongoDB Shell) binary
 */
export async function getMongoshPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('mongosh')
  if (cached && existsSync(cached)) return cached

  // Check common mongosh paths
  for (const path of HOMEBREW_MONGOSH_PATHS) {
    if (existsSync(path)) {
      logDebug(`Found mongosh at: ${path}`)
      return path
    }
  }

  // Check system PATH
  const systemPath = await platformService.findToolPath('mongosh')
  if (systemPath) {
    logDebug(`Found mongosh in PATH: ${systemPath}`)
    return systemPath
  }

  return null
}

/**
 * Find mongodump binary
 */
export async function getMongodumpPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('mongodump')
  if (cached && existsSync(cached)) return cached

  // Check Homebrew database-tools paths
  for (const dir of HOMEBREW_TOOLS_PATHS) {
    const path = `${dir}/mongodump`
    if (existsSync(path)) {
      logDebug(`Found mongodump at: ${path}`)
      return path
    }
  }

  // Check system PATH
  const systemPath = await platformService.findToolPath('mongodump')
  if (systemPath) {
    logDebug(`Found mongodump in PATH: ${systemPath}`)
    return systemPath
  }

  return null
}

/**
 * Find mongorestore binary
 */
export async function getMongorestorePath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('mongorestore')
  if (cached && existsSync(cached)) return cached

  // Check Homebrew database-tools paths
  for (const dir of HOMEBREW_TOOLS_PATHS) {
    const path = `${dir}/mongorestore`
    if (existsSync(path)) {
      logDebug(`Found mongorestore at: ${path}`)
      return path
    }
  }

  // Check system PATH
  const systemPath = await platformService.findToolPath('mongorestore')
  if (systemPath) {
    logDebug(`Found mongorestore in PATH: ${systemPath}`)
    return systemPath
  }

  return null
}

/**
 * Get MongoDB version from mongod --version output
 * Example output: "db version v8.0.4"
 */
export async function getMongodVersion(
  mongodPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${mongodPath}" --version`, {
      timeout: 5000,
    })
    // Parse version from "db version v8.0.4" or similar
    const match = stdout.match(/db version v?(\d+\.\d+\.\d+)/i)
    if (match) {
      return match[1]
    }
    // Also try matching just version number pattern
    const altMatch = stdout.match(/(\d+\.\d+\.\d+)/)
    return altMatch ? altMatch[1] : null
  } catch (error) {
    logDebug(`Failed to get mongod version: ${error}`)
    return null
  }
}

/**
 * Detect all installed MongoDB versions
 * Checks Homebrew versioned formulas and PATH
 * Returns map of major version -> full version string
 */
export async function detectInstalledVersions(): Promise<
  Record<string, string>
> {
  const versions: Record<string, string> = {}

  // Check all Homebrew paths
  for (const dir of HOMEBREW_MONGODB_PATHS) {
    const mongodPath = `${dir}/mongod`
    if (existsSync(mongodPath)) {
      const version = await getMongodVersion(mongodPath)
      if (version) {
        const major = version.split('.').slice(0, 2).join('.')
        versions[major] = version
        logDebug(`Detected MongoDB ${version} at ${mongodPath}`)
      }
    }
  }

  // Also check default PATH mongod
  const defaultMongod = await platformService.findToolPath('mongod')
  if (defaultMongod && !Object.values(versions).length) {
    const version = await getMongodVersion(defaultMongod)
    if (version) {
      const major = version.split('.').slice(0, 2).join('.')
      versions[major] = version
    }
  }

  return versions
}

/**
 * Get installation instructions for MongoDB
 */
export function getInstallInstructions(): string {
  const { platform } = platformService.getPlatformInfo()

  switch (platform) {
    case 'darwin':
      return `MongoDB is not installed. Install with Homebrew:
  brew tap mongodb/brew
  brew install mongodb-community

For a specific version:
  brew install mongodb-community@7.0

Also install the shell and database tools:
  brew install mongosh mongodb-database-tools`

    case 'linux':
      return `MongoDB is not installed. Follow the official installation guide:
  https://www.mongodb.com/docs/manual/administration/install-on-linux/

MongoDB requires adding their official repository for apt/yum.`

    case 'win32':
      return `MongoDB is not installed. Install with Chocolatey:
  choco install mongodb mongodb-shell mongodb-database-tools

Or download from: https://www.mongodb.com/try/download/community`

    default:
      return 'MongoDB is not installed. Visit https://www.mongodb.com/try/download/community'
  }
}
