/**
 * Platform Service
 *
 * Centralizes all OS-specific detection and behavior, similar to how
 * the engine abstraction handles database-specific behavior.
 *
 * This enables:
 * - Consistent platform detection across the codebase
 * - Easy mocking for unit tests
 * - Simple addition of new platforms (e.g., Windows)
 */

import { homedir, platform as osPlatform, arch as osArch } from 'os'
import { execSync, exec, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'

const execAsync = promisify(exec)

// =============================================================================
// Types
// =============================================================================

export type Platform = 'darwin' | 'linux' | 'win32'
export type Architecture = 'arm64' | 'x64'

export type PlatformInfo = {
  platform: Platform
  arch: Architecture
  homeDir: string
  isWSL: boolean
  isSudo: boolean
  sudoUser: string | null
}

export type ClipboardConfig = {
  copyCommand: string
  copyArgs: string[]
  pasteCommand: string
  pasteArgs: string[]
  available: boolean
}

export type WhichCommandConfig = {
  command: string
  args: string[]
}

export type PackageManagerInfo = {
  id: string
  name: string
  checkCommand: string
  installTemplate: string
  updateCommand: string
}

// =============================================================================
// Abstract Base Class
// =============================================================================

export abstract class BasePlatformService {
  protected cachedPlatformInfo: PlatformInfo | null = null

  /**
   * Get platform information
   */
  abstract getPlatformInfo(): PlatformInfo

  /**
   * Get clipboard configuration for this platform
   */
  abstract getClipboardConfig(): ClipboardConfig

  /**
   * Get the "which" command equivalent for this platform
   */
  abstract getWhichCommand(): WhichCommandConfig

  /**
   * Get common search paths for a tool on this platform
   */
  abstract getSearchPaths(tool: string): string[]

  /**
   * Detect available package manager
   */
  abstract detectPackageManager(): Promise<PackageManagerInfo | null>

  /**
   * Get the zonky.io platform identifier for PostgreSQL binaries
   */
  abstract getZonkyPlatform(): string | null

  /**
   * Copy text to clipboard
   */
  async copyToClipboard(text: string): Promise<boolean> {
    const config = this.getClipboardConfig()
    if (!config.available) return false

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(config.copyCommand, config.copyArgs, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })
        proc.stdin?.write(text)
        proc.stdin?.end()
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Clipboard command exited with code ${code}`))
        })
        proc.on('error', reject)
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Check if a tool is installed and return its path
   */
  async findToolPath(toolName: string): Promise<string | null> {
    const whichConfig = this.getWhichCommand()

    // First try the which/where command
    try {
      const { stdout } = await execAsync(
        `${whichConfig.command} ${toolName}`,
      )
      const path = stdout.trim().split('\n')[0]
      if (path && existsSync(path)) {
        return path
      }
    } catch {
      // Not found via which, continue to search paths
    }

    // Search common installation paths
    const searchPaths = this.getSearchPaths(toolName)
    for (const dir of searchPaths) {
      const fullPath = this.buildToolPath(dir, toolName)
      if (existsSync(fullPath)) {
        return fullPath
      }
    }

    return null
  }

  /**
   * Build the full path to a tool in a directory
   */
  protected abstract buildToolPath(dir: string, toolName: string): string

  /**
   * Get tool version by running --version
   */
  async getToolVersion(toolPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`"${toolPath}" --version`)
      const match = stdout.match(/(\d+\.\d+(\.\d+)?)/)
      return match ? match[1] : null
    } catch {
      return null
    }
  }
}

// =============================================================================
// Darwin (macOS) Implementation
// =============================================================================

class DarwinPlatformService extends BasePlatformService {
  getPlatformInfo(): PlatformInfo {
    if (this.cachedPlatformInfo) return this.cachedPlatformInfo

    const sudoUser = process.env.SUDO_USER || null
    let homeDir: string

    if (sudoUser) {
      // Running under sudo - get original user's home
      try {
        const result = execSync(`getent passwd ${sudoUser}`, {
          encoding: 'utf-8',
        })
        const parts = result.trim().split(':')
        homeDir = parts.length >= 6 && parts[5] ? parts[5] : `/Users/${sudoUser}`
      } catch {
        homeDir = `/Users/${sudoUser}`
      }
    } else {
      homeDir = homedir()
    }

    this.cachedPlatformInfo = {
      platform: 'darwin',
      arch: osArch() as Architecture,
      homeDir,
      isWSL: false,
      isSudo: !!sudoUser,
      sudoUser,
    }

    return this.cachedPlatformInfo
  }

  getClipboardConfig(): ClipboardConfig {
    return {
      copyCommand: 'pbcopy',
      copyArgs: [],
      pasteCommand: 'pbpaste',
      pasteArgs: [],
      available: true, // pbcopy is always available on macOS
    }
  }

  getWhichCommand(): WhichCommandConfig {
    return {
      command: 'which',
      args: [],
    }
  }

  getSearchPaths(tool: string): string[] {
    const paths: string[] = []

    // MySQL-specific paths
    if (
      tool === 'mysqld' ||
      tool === 'mysql' ||
      tool === 'mysqladmin' ||
      tool === 'mysqldump'
    ) {
      paths.push(
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
      )
    }

    // PostgreSQL-specific paths
    if (
      tool === 'psql' ||
      tool === 'pg_dump' ||
      tool === 'pg_restore' ||
      tool === 'pg_basebackup'
    ) {
      paths.push(
        // Homebrew (Apple Silicon)
        '/opt/homebrew/bin',
        '/opt/homebrew/opt/postgresql/bin',
        '/opt/homebrew/opt/postgresql@17/bin',
        '/opt/homebrew/opt/postgresql@16/bin',
        '/opt/homebrew/opt/postgresql@15/bin',
        '/opt/homebrew/opt/postgresql@14/bin',
        // Homebrew (Intel)
        '/usr/local/bin',
        '/usr/local/opt/postgresql/bin',
        '/usr/local/opt/postgresql@17/bin',
        '/usr/local/opt/postgresql@16/bin',
        '/usr/local/opt/postgresql@15/bin',
        '/usr/local/opt/postgresql@14/bin',
        // Postgres.app
        '/Applications/Postgres.app/Contents/Versions/latest/bin',
      )
    }

    // Generic paths
    paths.push('/usr/local/bin', '/usr/bin')

    return paths
  }

  async detectPackageManager(): Promise<PackageManagerInfo | null> {
    try {
      await execAsync('brew --version')
      return {
        id: 'brew',
        name: 'Homebrew',
        checkCommand: 'brew --version',
        installTemplate: 'brew install {package}',
        updateCommand: 'brew update',
      }
    } catch {
      return null
    }
  }

  getZonkyPlatform(): string | null {
    const arch = osArch()
    if (arch === 'arm64') return 'darwin-arm64v8'
    if (arch === 'x64') return 'darwin-amd64'
    return null
  }

  protected buildToolPath(dir: string, toolName: string): string {
    return `${dir}/${toolName}`
  }
}

// =============================================================================
// Linux Implementation
// =============================================================================

class LinuxPlatformService extends BasePlatformService {
  getPlatformInfo(): PlatformInfo {
    if (this.cachedPlatformInfo) return this.cachedPlatformInfo

    const sudoUser = process.env.SUDO_USER || null
    let homeDir: string

    if (sudoUser) {
      try {
        const result = execSync(`getent passwd ${sudoUser}`, {
          encoding: 'utf-8',
        })
        const parts = result.trim().split(':')
        homeDir = parts.length >= 6 && parts[5] ? parts[5] : `/home/${sudoUser}`
      } catch {
        homeDir = `/home/${sudoUser}`
      }
    } else {
      homeDir = homedir()
    }

    // Check if running in WSL
    let isWSL = false
    try {
      const uname = execSync('uname -r', { encoding: 'utf-8' })
      isWSL = uname.toLowerCase().includes('microsoft')
    } catch {
      // Not WSL
    }

    this.cachedPlatformInfo = {
      platform: 'linux',
      arch: osArch() as Architecture,
      homeDir,
      isWSL,
      isSudo: !!sudoUser,
      sudoUser,
    }

    return this.cachedPlatformInfo
  }

  getClipboardConfig(): ClipboardConfig {
    // Check if xclip is available
    let available = false
    try {
      execSync('which xclip', { encoding: 'utf-8' })
      available = true
    } catch {
      // xclip not installed
    }

    return {
      copyCommand: 'xclip',
      copyArgs: ['-selection', 'clipboard'],
      pasteCommand: 'xclip',
      pasteArgs: ['-selection', 'clipboard', '-o'],
      available,
    }
  }

  getWhichCommand(): WhichCommandConfig {
    return {
      command: 'which',
      args: [],
    }
  }

  getSearchPaths(tool: string): string[] {
    const paths: string[] = []

    // MySQL-specific paths
    if (
      tool === 'mysqld' ||
      tool === 'mysql' ||
      tool === 'mysqladmin' ||
      tool === 'mysqldump'
    ) {
      paths.push(
        '/usr/bin',
        '/usr/sbin',
        '/usr/local/bin',
        '/usr/local/mysql/bin',
      )
    }

    // PostgreSQL-specific paths
    if (
      tool === 'psql' ||
      tool === 'pg_dump' ||
      tool === 'pg_restore' ||
      tool === 'pg_basebackup'
    ) {
      paths.push(
        '/usr/bin',
        '/usr/local/bin',
        '/usr/lib/postgresql/17/bin',
        '/usr/lib/postgresql/16/bin',
        '/usr/lib/postgresql/15/bin',
        '/usr/lib/postgresql/14/bin',
      )
    }

    // Generic paths
    paths.push('/usr/bin', '/usr/local/bin')

    return paths
  }

  async detectPackageManager(): Promise<PackageManagerInfo | null> {
    // Try apt first (Debian/Ubuntu)
    try {
      await execAsync('apt --version')
      return {
        id: 'apt',
        name: 'APT',
        checkCommand: 'apt --version',
        installTemplate: 'sudo apt install -y {package}',
        updateCommand: 'sudo apt update',
      }
    } catch {
      // Not apt
    }

    // Try dnf (Fedora/RHEL 8+)
    try {
      await execAsync('dnf --version')
      return {
        id: 'dnf',
        name: 'DNF',
        checkCommand: 'dnf --version',
        installTemplate: 'sudo dnf install -y {package}',
        updateCommand: 'sudo dnf check-update',
      }
    } catch {
      // Not dnf
    }

    // Try yum (RHEL/CentOS 7)
    try {
      await execAsync('yum --version')
      return {
        id: 'yum',
        name: 'YUM',
        checkCommand: 'yum --version',
        installTemplate: 'sudo yum install -y {package}',
        updateCommand: 'sudo yum check-update',
      }
    } catch {
      // Not yum
    }

    // Try pacman (Arch)
    try {
      await execAsync('pacman --version')
      return {
        id: 'pacman',
        name: 'Pacman',
        checkCommand: 'pacman --version',
        installTemplate: 'sudo pacman -S --noconfirm {package}',
        updateCommand: 'sudo pacman -Sy',
      }
    } catch {
      // Not pacman
    }

    return null
  }

  getZonkyPlatform(): string | null {
    const arch = osArch()
    if (arch === 'arm64') return 'linux-arm64v8'
    if (arch === 'x64') return 'linux-amd64'
    return null
  }

  protected buildToolPath(dir: string, toolName: string): string {
    return `${dir}/${toolName}`
  }
}

// =============================================================================
// Windows Implementation (Stub for future support)
// =============================================================================

class Win32PlatformService extends BasePlatformService {
  getPlatformInfo(): PlatformInfo {
    if (this.cachedPlatformInfo) return this.cachedPlatformInfo

    this.cachedPlatformInfo = {
      platform: 'win32',
      arch: osArch() as Architecture,
      homeDir: homedir(),
      isWSL: false,
      isSudo: false,
      sudoUser: null,
    }

    return this.cachedPlatformInfo
  }

  getClipboardConfig(): ClipboardConfig {
    return {
      copyCommand: 'clip',
      copyArgs: [],
      pasteCommand: 'powershell',
      pasteArgs: ['-command', 'Get-Clipboard'],
      available: true,
    }
  }

  getWhichCommand(): WhichCommandConfig {
    return {
      command: 'where',
      args: [],
    }
  }

  getSearchPaths(tool: string): string[] {
    const paths: string[] = []

    // MySQL-specific paths
    if (
      tool === 'mysqld' ||
      tool === 'mysql' ||
      tool === 'mysqladmin' ||
      tool === 'mysqldump'
    ) {
      paths.push(
        'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin',
        'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin',
        'C:\\Program Files\\MySQL\\MySQL Server 5.7\\bin',
      )
    }

    // PostgreSQL-specific paths
    if (
      tool === 'psql' ||
      tool === 'pg_dump' ||
      tool === 'pg_restore' ||
      tool === 'pg_basebackup'
    ) {
      paths.push(
        'C:\\Program Files\\PostgreSQL\\17\\bin',
        'C:\\Program Files\\PostgreSQL\\16\\bin',
        'C:\\Program Files\\PostgreSQL\\15\\bin',
        'C:\\Program Files\\PostgreSQL\\14\\bin',
      )
    }

    return paths
  }

  async detectPackageManager(): Promise<PackageManagerInfo | null> {
    // Try chocolatey
    try {
      await execAsync('choco --version')
      return {
        id: 'choco',
        name: 'Chocolatey',
        checkCommand: 'choco --version',
        installTemplate: 'choco install -y {package}',
        updateCommand: 'choco upgrade all',
      }
    } catch {
      // Not chocolatey
    }

    // Try winget
    try {
      await execAsync('winget --version')
      return {
        id: 'winget',
        name: 'Windows Package Manager',
        checkCommand: 'winget --version',
        installTemplate: 'winget install {package}',
        updateCommand: 'winget upgrade --all',
      }
    } catch {
      // Not winget
    }

    return null
  }

  getZonkyPlatform(): string | null {
    // zonky.io doesn't provide Windows binaries
    return null
  }

  protected buildToolPath(dir: string, toolName: string): string {
    return `${dir}\\${toolName}.exe`
  }
}

// =============================================================================
// Factory and Singleton
// =============================================================================

/**
 * Create the appropriate platform service for the current OS
 */
export function createPlatformService(): BasePlatformService {
  const platform = osPlatform()

  switch (platform) {
    case 'darwin':
      return new DarwinPlatformService()
    case 'linux':
      return new LinuxPlatformService()
    case 'win32':
      return new Win32PlatformService()
    default:
      throw new Error(`Unsupported platform: ${platform}`)
  }
}

// Export singleton instance for convenience
export const platformService = createPlatformService()
