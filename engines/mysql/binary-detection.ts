/**
 * MySQL binary detection for system-installed MySQL
 * Detects MySQL installations from Homebrew, apt, or other package managers
 */

import { exec } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { promisify } from 'util'
import { platformService } from '../../core/platform-service'

const execAsync = promisify(exec)

// Find a MySQL binary by name using the platform service
export async function findMysqlBinary(name: string): Promise<string | null> {
  return platformService.findToolPath(name)
}

// Get the path to mysqld (MySQL server)
export async function getMysqldPath(): Promise<string | null> {
  return findMysqlBinary('mysqld')
}

// Get the path to mysql client
export async function getMysqlClientPath(): Promise<string | null> {
  return findMysqlBinary('mysql')
}

// Get the path to mysqladmin
export async function getMysqladminPath(): Promise<string | null> {
  return findMysqlBinary('mysqladmin')
}

// Get the path to mysqldump
export async function getMysqldumpPath(): Promise<string | null> {
  return findMysqlBinary('mysqldump')
}

// Get the path to mysql_install_db (MariaDB initialization script)
export async function getMysqlInstallDbPath(): Promise<string | null> {
  return findMysqlBinary('mysql_install_db')
}

// Get the path to mariadb-install-db (alternative MariaDB initialization)
export async function getMariadbInstallDbPath(): Promise<string | null> {
  return findMysqlBinary('mariadb-install-db')
}

// Detect if the installed MySQL is actually MariaDB
export async function isMariaDB(): Promise<boolean> {
  const mysqld = await getMysqldPath()
  if (!mysqld) return false

  try {
    const { stdout } = await execAsync(`"${mysqld}" --version`)
    return stdout.toLowerCase().includes('mariadb')
  } catch {
    return false
  }
}

// Get the MySQL server version from a mysqld binary
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
 * e.g., "8.0.35" -> "8.0", "v8.0.35" -> "8.0", "8" -> "8"
 */
export function getMajorVersion(fullVersion: string): string {
  if (!fullVersion) return ''

  // Trim whitespace and strip leading "v" prefix
  const normalized = fullVersion.trim().replace(/^v/i, '')
  if (!normalized) return ''

  const parts = normalized.split('.')

  // If only one part (e.g., "8"), return it as-is
  if (parts.length < 2) {
    return parts[0] || ''
  }

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
  const { platform } = platformService.getPlatformInfo()

  // Check default mysqld
  const defaultMysqld = await getMysqldPath()
  if (defaultMysqld) {
    const version = await getMysqlVersion(defaultMysqld)
    if (version) {
      const major = getMajorVersion(version)
      versions[major] = version
    }
  }

  // Check versioned Homebrew installations (macOS only)
  if (platform === 'darwin') {
    const homebrewPaths = [
      '/opt/homebrew/opt/mysql@5.7/bin/mysqld',
      '/opt/homebrew/opt/mysql@8.0/bin/mysqld',
      '/opt/homebrew/opt/mysql@8.4/bin/mysqld',
      '/usr/local/opt/mysql@5.7/bin/mysqld',
      '/usr/local/opt/mysql@8.0/bin/mysqld',
      '/usr/local/opt/mysql@8.4/bin/mysqld',
    ]

    for (const path of homebrewPaths) {
      if (existsSync(path)) {
        const version = await getMysqlVersion(path)
        if (version) {
          const major = getMajorVersion(version)
          if (!versions[major]) {
            versions[major] = version
          }
        }
      }
    }
  }

  return versions
}

/**
 * Version-specific Homebrew paths for MySQL
 * Used to find binaries for a specific major version
 */
const HOMEBREW_MYSQL_VERSION_PATHS: Record<string, string[]> = {
  '9': [
    '/opt/homebrew/opt/mysql@9.0/bin',
    '/opt/homebrew/opt/mysql/bin', // Unversioned formula might be v9
    '/usr/local/opt/mysql@9.0/bin',
    '/usr/local/opt/mysql/bin',
  ],
  '8': [
    '/opt/homebrew/opt/mysql@8.0/bin',
    '/opt/homebrew/opt/mysql@8.4/bin',
    '/opt/homebrew/opt/mysql/bin', // Unversioned formula might be v8
    '/usr/local/opt/mysql@8.0/bin',
    '/usr/local/opt/mysql@8.4/bin',
    '/usr/local/opt/mysql/bin',
  ],
  '5': ['/opt/homebrew/opt/mysql@5.7/bin', '/usr/local/opt/mysql@5.7/bin'],
}

// Get mysqld path for a specific major version
export async function getMysqldPathForVersion(
  majorVersion: string,
): Promise<string | null> {
  const { platform } = platformService.getPlatformInfo()

  // On macOS, check version-specific Homebrew paths
  if (platform === 'darwin') {
    const paths = HOMEBREW_MYSQL_VERSION_PATHS[majorVersion] || []
    for (const dir of paths) {
      const mysqldPath = `${dir}/mysqld`
      if (existsSync(mysqldPath)) {
        // Verify this is the correct major version
        const version = await getMysqlVersion(mysqldPath)
        if (version) {
          const detectedMajor = getMajorVersion(version).split('.')[0]
          if (detectedMajor === majorVersion) {
            return mysqldPath
          }
        }
      }
    }
  }

  // Fall back to generic detection and version check
  const genericPath = await getMysqldPath()
  if (genericPath) {
    const version = await getMysqlVersion(genericPath)
    if (version) {
      const detectedMajor = getMajorVersion(version).split('.')[0]
      if (detectedMajor === majorVersion) {
        return genericPath
      }
    }
  }

  return null
}

// Get install instructions for MySQL
export function getInstallInstructions(): string {
  const { platform } = platformService.getPlatformInfo()

  if (platform === 'darwin') {
    return (
      'MySQL server not found. Install MySQL:\n' +
      '  brew install mysql\n' +
      '  # or for a specific version:\n' +
      '  brew install mysql@8.0'
    )
  }

  if (platform === 'linux') {
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

export type MysqlPackageManager =
  | 'homebrew'
  | 'apt'
  | 'yum'
  | 'dnf'
  | 'pacman'
  | 'unknown'

export type MysqlInstallInfo = {
  packageManager: MysqlPackageManager
  packageName: string
  path: string
  uninstallCommand: string
  isMariaDB: boolean
}

// Detect which package manager installed MySQL and get uninstall info
export async function getMysqlInstallInfo(
  mysqldPath: string,
): Promise<MysqlInstallInfo> {
  const { platform } = platformService.getPlatformInfo()
  const mariadb = await isMariaDB()

  // Resolve symlinks to get the actual path
  // e.g., /opt/homebrew/bin/mysqld -> /opt/homebrew/Cellar/mysql/9.5.0/bin/mysqld
  let resolvedPath = mysqldPath
  try {
    resolvedPath = realpathSync(mysqldPath)
  } catch {
    // If symlink resolution fails, use the original path
  }

  // macOS: Check if path is in Homebrew directories
  if (platform === 'darwin') {
    if (
      mysqldPath.includes('/opt/homebrew/') ||
      mysqldPath.includes('/usr/local/Cellar/') ||
      resolvedPath.includes('/opt/homebrew/') ||
      resolvedPath.includes('/usr/local/Cellar/')
    ) {
      // Extract package name from resolved path
      // e.g., /opt/homebrew/Cellar/mysql/9.5.0/bin/mysqld -> mysql
      // e.g., /opt/homebrew/Cellar/mysql@8.0/8.0.35/bin/mysqld -> mysql@8.0
      // e.g., /opt/homebrew/opt/mysql@8.0/bin/mysqld -> mysql@8.0
      let packageName = mariadb ? 'mariadb' : 'mysql'

      // Try to extract from Cellar path first (most reliable after symlink resolution)
      // Format: /opt/homebrew/Cellar/<formula>/<version>/bin/mysqld
      const cellarMatch = resolvedPath.match(
        /\/(?:opt\/homebrew|usr\/local)\/Cellar\/([^/]+)\//,
      )
      if (cellarMatch) {
        packageName = cellarMatch[1]
      } else {
        // Fall back to opt path pattern
        // Format: /opt/homebrew/opt/<formula>/bin/mysqld
        const optMatch = resolvedPath.match(
          /\/(?:opt\/homebrew|usr\/local)\/opt\/([^/]+)\//,
        )
        if (optMatch) {
          packageName = optMatch[1]
        }
      }

      return {
        packageManager: 'homebrew',
        packageName,
        path: mysqldPath,
        uninstallCommand: `brew uninstall ${packageName}`,
        isMariaDB: mariadb,
      }
    }
  }

  // Linux: Detect package manager using memoized helper
  if (platform === 'linux') {
    const pm = await getLinuxPackageManager()
    if (pm) {
      const packageName = mariadb ? pm.mariadbPackage : pm.mysqlPackage
      return {
        packageManager: pm.name,
        packageName,
        path: mysqldPath,
        uninstallCommand: pm.uninstallCmd(packageName),
        isMariaDB: mariadb,
      }
    }
  }

  // Unknown package manager
  return {
    packageManager: 'unknown',
    packageName: mariadb ? 'mariadb' : 'mysql',
    path: mysqldPath,
    uninstallCommand: 'Use your system package manager to uninstall',
    isMariaDB: mariadb,
  }
}

/**
 * Linux package manager configuration
 * Prioritized list: most common package managers first for faster detection
 */
type LinuxPackageManagerConfig = {
  name: MysqlPackageManager
  command: string
  mysqlPackage: string
  mariadbPackage: string
  uninstallCmd: (pkg: string) => string
}

const LINUX_PACKAGE_MANAGERS: LinuxPackageManagerConfig[] = [
  {
    name: 'apt',
    command: 'apt',
    mysqlPackage: 'mysql-server',
    mariadbPackage: 'mariadb-server',
    uninstallCmd: (pkg) => `sudo apt remove ${pkg}`,
  },
  {
    name: 'dnf',
    command: 'dnf',
    mysqlPackage: 'mysql-server',
    mariadbPackage: 'mariadb-server',
    uninstallCmd: (pkg) => `sudo dnf remove ${pkg}`,
  },
  {
    name: 'yum',
    command: 'yum',
    mysqlPackage: 'mysql-server',
    mariadbPackage: 'mariadb-server',
    uninstallCmd: (pkg) => `sudo yum remove ${pkg}`,
  },
  {
    name: 'pacman',
    command: 'pacman',
    mysqlPackage: 'mysql',
    mariadbPackage: 'mariadb',
    uninstallCmd: (pkg) => `sudo pacman -Rs ${pkg}`,
  },
]

// Memoized Linux package manager detection result
let cachedLinuxPackageManager: LinuxPackageManagerConfig | null | undefined

/**
 * Detect the Linux package manager (memoized)
 * Returns the first available package manager from the prioritized list
 */
async function getLinuxPackageManager(): Promise<LinuxPackageManagerConfig | null> {
  // Return cached result if available (undefined means not checked yet)
  if (cachedLinuxPackageManager !== undefined) {
    return cachedLinuxPackageManager
  }

  for (const pm of LINUX_PACKAGE_MANAGERS) {
    try {
      const { stdout } = await execAsync(`which ${pm.command} 2>/dev/null`)
      if (stdout.trim()) {
        cachedLinuxPackageManager = pm
        return pm
      }
    } catch {
      // Package manager not found, try next
    }
  }

  cachedLinuxPackageManager = null
  return null
}

/**
 * Clear the memoized package manager cache (useful for testing)
 */
export function clearPackageManagerCache(): void {
  cachedLinuxPackageManager = undefined
}
