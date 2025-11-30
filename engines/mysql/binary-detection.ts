/**
 * MySQL binary detection for system-installed MySQL
 * Detects MySQL installations from Homebrew, apt, or other package managers
 */

import { exec } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import { platformService } from '../../core/platform-service'

const execAsync = promisify(exec)

/**
 * Find a MySQL binary by name using the platform service
 */
export async function findMysqlBinary(name: string): Promise<string | null> {
  return platformService.findToolPath(name)
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
 * Get the path to mysql_install_db (MariaDB initialization script)
 */
export async function getMysqlInstallDbPath(): Promise<string | null> {
  return findMysqlBinary('mysql_install_db')
}

/**
 * Get the path to mariadb-install-db (alternative MariaDB initialization)
 */
export async function getMariadbInstallDbPath(): Promise<string | null> {
  return findMysqlBinary('mariadb-install-db')
}

/**
 * Detect if the installed MySQL is actually MariaDB
 */
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
 * Get install instructions for MySQL
 */
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

/**
 * Detect which package manager installed MySQL and get uninstall info
 */
export async function getMysqlInstallInfo(
  mysqldPath: string,
): Promise<MysqlInstallInfo> {
  const { platform } = platformService.getPlatformInfo()
  const mariadb = await isMariaDB()

  // macOS: Check if path is in Homebrew directories
  if (platform === 'darwin') {
    if (
      mysqldPath.includes('/opt/homebrew/') ||
      mysqldPath.includes('/usr/local/Cellar/')
    ) {
      // Extract package name from path
      // e.g., /opt/homebrew/opt/mysql@8.0/bin/mysqld -> mysql@8.0
      // e.g., /opt/homebrew/bin/mysqld -> mysql (linked)
      let packageName = mariadb ? 'mariadb' : 'mysql'

      const versionMatch = mysqldPath.match(/mysql@(\d+\.\d+)/)
      if (versionMatch) {
        packageName = `mysql@${versionMatch[1]}`
      } else {
        // Try to get from Homebrew directly
        try {
          const { stdout } = await execAsync('brew list --formula')
          const packages = stdout.split('\n')
          const mysqlPackage = packages.find(
            (p) =>
              p.startsWith('mysql') ||
              p.startsWith('mariadb') ||
              p === 'percona-server',
          )
          if (mysqlPackage) {
            packageName = mysqlPackage
          }
        } catch {
          // Ignore errors
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

  // Linux: Detect package manager from path or check installed packages
  if (platform === 'linux') {
    // Check for apt (Debian/Ubuntu)
    try {
      const { stdout } = await execAsync('which apt 2>/dev/null')
      if (stdout.trim()) {
        const packageName = mariadb ? 'mariadb-server' : 'mysql-server'
        return {
          packageManager: 'apt',
          packageName,
          path: mysqldPath,
          uninstallCommand: `sudo apt remove ${packageName}`,
          isMariaDB: mariadb,
        }
      }
    } catch {
      // Not apt
    }

    // Check for dnf (Fedora/RHEL 8+)
    try {
      const { stdout } = await execAsync('which dnf 2>/dev/null')
      if (stdout.trim()) {
        const packageName = mariadb ? 'mariadb-server' : 'mysql-server'
        return {
          packageManager: 'dnf',
          packageName,
          path: mysqldPath,
          uninstallCommand: `sudo dnf remove ${packageName}`,
          isMariaDB: mariadb,
        }
      }
    } catch {
      // Not dnf
    }

    // Check for yum (CentOS/RHEL 7)
    try {
      const { stdout } = await execAsync('which yum 2>/dev/null')
      if (stdout.trim()) {
        const packageName = mariadb ? 'mariadb-server' : 'mysql-server'
        return {
          packageManager: 'yum',
          packageName,
          path: mysqldPath,
          uninstallCommand: `sudo yum remove ${packageName}`,
          isMariaDB: mariadb,
        }
      }
    } catch {
      // Not yum
    }

    // Check for pacman (Arch Linux)
    try {
      const { stdout } = await execAsync('which pacman 2>/dev/null')
      if (stdout.trim()) {
        const packageName = mariadb ? 'mariadb' : 'mysql'
        return {
          packageManager: 'pacman',
          packageName,
          path: mysqldPath,
          uninstallCommand: `sudo pacman -Rs ${packageName}`,
          isMariaDB: mariadb,
        }
      }
    } catch {
      // Not pacman
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
