/**
 * MySQL binary detection for system-installed MySQL
 * Detects MySQL installations from Homebrew, apt, or other package managers
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { platform } from 'os'

const execAsync = promisify(exec)

/**
 * Common paths where MySQL binaries might be installed
 */
const MYSQL_SEARCH_PATHS = {
  darwin: [
    // Homebrew (Apple Silicon)
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/mysql/bin',
    '/opt/homebrew/opt/mysql@8.0/bin',
    '/opt/homebrew/opt/mysql@8.4/bin',
    '/opt/homebrew/opt/mysql@5.7/bin',
    // Homebrew (Intel)
    '/usr/local/bin',
    '/usr/local/opt/mysql/bin',
    '/usr/local/opt/mysql@8.0/bin',
    '/usr/local/opt/mysql@8.4/bin',
    '/usr/local/opt/mysql@5.7/bin',
    // Official MySQL installer
    '/usr/local/mysql/bin',
  ],
  linux: [
    '/usr/bin',
    '/usr/sbin',
    '/usr/local/bin',
    '/usr/local/mysql/bin',
  ],
  win32: [
    'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin',
    'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin',
    'C:\\Program Files\\MySQL\\MySQL Server 5.7\\bin',
  ],
}

/**
 * Get search paths for the current platform
 */
function getSearchPaths(): string[] {
  const plat = platform()
  return MYSQL_SEARCH_PATHS[plat as keyof typeof MYSQL_SEARCH_PATHS] || []
}

/**
 * Check if a binary exists at the given path
 */
function binaryExists(path: string): boolean {
  return existsSync(path)
}

/**
 * Find a MySQL binary by name
 */
export async function findMysqlBinary(
  name: string,
): Promise<string | null> {
  // First, try using 'which' or 'where' command
  try {
    const cmd = platform() === 'win32' ? 'where' : 'which'
    const { stdout } = await execAsync(`${cmd} ${name}`)
    const path = stdout.trim().split('\n')[0]
    if (path && binaryExists(path)) {
      return path
    }
  } catch {
    // Not found in PATH, continue to search common locations
  }

  // Search common installation paths
  const searchPaths = getSearchPaths()
  for (const dir of searchPaths) {
    const fullPath = platform() === 'win32'
      ? `${dir}\\${name}.exe`
      : `${dir}/${name}`
    if (binaryExists(fullPath)) {
      return fullPath
    }
  }

  return null
}

/**
 * Get the path to mysqld (MySQL server)
 */
export async function getMysqldPath(): Promise<string | null> {
  return findMysqlBinary('mysqld')
}

/**
 * Get the path to mysql client
 */
export async function getMysqlClientPath(): Promise<string | null> {
  return findMysqlBinary('mysql')
}

/**
 * Get the path to mysqladmin
 */
export async function getMysqladminPath(): Promise<string | null> {
  return findMysqlBinary('mysqladmin')
}

/**
 * Get the path to mysqldump
 */
export async function getMysqldumpPath(): Promise<string | null> {
  return findMysqlBinary('mysqldump')
}

/**
 * Get the MySQL server version from a mysqld binary
 */
export async function getMysqlVersion(
  mysqldPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${mysqldPath}" --version`)
    // Example output: mysqld  Ver 8.0.35 for macos14.0 on arm64 (Homebrew)
    const match = stdout.match(/Ver\s+(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Get the major version from a full version string
 * e.g., "8.0.35" -> "8.0"
 */
export function getMajorVersion(fullVersion: string): string {
  const parts = fullVersion.split('.')
  return `${parts[0]}.${parts[1]}`
}

/**
 * Detect all installed MySQL versions
 * Returns a map of major version -> full version string
 */
export async function detectInstalledVersions(): Promise<
  Record<string, string>
> {
  const versions: Record<string, string> = {}

  // Check default mysqld
  const defaultMysqld = await getMysqldPath()
  if (defaultMysqld) {
    const version = await getMysqlVersion(defaultMysqld)
    if (version) {
      const major = getMajorVersion(version)
      versions[major] = version
    }
  }

  // Check versioned Homebrew installations
  const homebrewPaths = platform() === 'darwin'
    ? [
        '/opt/homebrew/opt/mysql@5.7/bin/mysqld',
        '/opt/homebrew/opt/mysql@8.0/bin/mysqld',
        '/opt/homebrew/opt/mysql@8.4/bin/mysqld',
        '/usr/local/opt/mysql@5.7/bin/mysqld',
        '/usr/local/opt/mysql@8.0/bin/mysqld',
        '/usr/local/opt/mysql@8.4/bin/mysqld',
      ]
    : []

  for (const path of homebrewPaths) {
    if (binaryExists(path)) {
      const version = await getMysqlVersion(path)
      if (version) {
        const major = getMajorVersion(version)
        if (!versions[major]) {
          versions[major] = version
        }
      }
    }
  }

  return versions
}

/**
 * Get install instructions for MySQL
 */
export function getInstallInstructions(): string {
  const plat = platform()

  if (plat === 'darwin') {
    return (
      'MySQL server not found. Install MySQL:\n' +
      '  brew install mysql\n' +
      '  # or for a specific version:\n' +
      '  brew install mysql@8.0'
    )
  }

  if (plat === 'linux') {
    return (
      'MySQL server not found. Install MySQL:\n' +
      '  Ubuntu/Debian: sudo apt install mysql-server\n' +
      '  RHEL/CentOS: sudo yum install mysql-server'
    )
  }

  return (
    'MySQL server not found. Please install MySQL from:\n' +
    '  https://dev.mysql.com/downloads/mysql/'
  )
}
