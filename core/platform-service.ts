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
import { execSync, execFileSync, exec, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { Platform, Arch } from '../types'

const execAsync = promisify(exec)

export { Platform, Arch }

/**
 * Validates and normalizes the system architecture to a supported Arch enum value.
 * Throws an error for unsupported architectures rather than casting unsafely.
 */
function validateArch(arch: string): Arch {
  switch (arch) {
    case 'arm64':
      return Arch.ARM64
    case 'x64':
      return Arch.X64
    default:
      throw new Error(
        `Unsupported architecture: ${arch}. SpinDB only supports arm64 and x64 architectures.`,
      )
  }
}

// Options for resolving home directory under sudo
export type ResolveHomeDirOptions = {
  sudoUser: string | null
  getentResult: string | null
  platform: Platform.Darwin | Platform.Linux
  defaultHome: string
}

/**
 * Resolve the correct home directory, handling sudo scenarios.
 * This is extracted as a pure function for testability.
 *
 * When running under sudo, we need to use the original user's home directory,
 * not root's home. This prevents ~/.spindb from being created in /root/.
 */
export function resolveHomeDir(options: ResolveHomeDirOptions): string {
  const { sudoUser, getentResult, platform, defaultHome } = options

  // Not running under sudo - use default
  if (!sudoUser) {
    return defaultHome
  }

  // Try to parse home from getent passwd output
  // Format: username:password:uid:gid:gecos:home:shell
  if (getentResult) {
    const parts = getentResult.trim().split(':')
    if (parts.length >= 6 && parts[5]) {
      return parts[5]
    }
  }

  // Fallback to platform-specific default
  return platform === Platform.Darwin ? `/Users/${sudoUser}` : `/home/${sudoUser}`
}

export type PlatformInfo = {
  platform: Platform
  arch: Arch
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

export abstract class BasePlatformService {
  protected cachedPlatformInfo: PlatformInfo | null = null

  // Get platform information
  abstract getPlatformInfo(): PlatformInfo

  // Get clipboard configuration for this platform
  abstract getClipboardConfig(): ClipboardConfig

  // Get the "which" command equivalent for this platform
  abstract getWhichCommand(): WhichCommandConfig

  // Get common search paths for a tool on this platform
  abstract getSearchPaths(tool: string): string[]

  // Detect available package manager
  abstract detectPackageManager(): Promise<PackageManagerInfo | null>

  // Get the null device path for this platform ('/dev/null' on Unix, 'NUL' on Windows)
  abstract getNullDevice(): string

  // Get the executable file extension for this platform ('' on Unix, '.exe' on Windows)
  abstract getExecutableExtension(): string

  /**
   * Terminate a process by PID
   * @param pid - Process ID to terminate
   * @param force - If true, force kill (SIGKILL on Unix, /F on Windows)
   */
  abstract terminateProcess(pid: number, force: boolean): Promise<void>

  // Check if a process is running by PID
  abstract isProcessRunning(pid: number): boolean

  /**
   * Find process PIDs listening on a specific port
   * @param port - Port number to check
   * @returns Array of PIDs listening on the port (empty if none found)
   */
  abstract findProcessByPort(port: number): Promise<number[]>

  // Copy text to clipboard
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

  // Check if a tool is installed and return its path
  async findToolPath(toolName: string): Promise<string | null> {
    const whichConfig = this.getWhichCommand()

    // First try the which/where command (with timeout to prevent hanging)
    try {
      const cmd = [whichConfig.command, ...whichConfig.args, toolName]
        .filter(Boolean)
        .join(' ')
      const { stdout } = await execAsync(cmd, { timeout: 5000 })
      const path = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (path && existsSync(path)) return path
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

  // Build the full path to a tool in a directory
  protected abstract buildToolPath(dir: string, toolName: string): string

  // Get tool version by running --version
  async getToolVersion(toolPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`"${toolPath}" --version`, {
        timeout: 5000,
      })
      const match = stdout.match(/(\d+\.\d+(\.\d+)?)/)
      return match ? match[1] : null
    } catch {
      return null
    }
  }
}

class DarwinPlatformService extends BasePlatformService {
  getPlatformInfo(): PlatformInfo {
    if (this.cachedPlatformInfo) return this.cachedPlatformInfo

    const sudoUser = process.env.SUDO_USER || null

    // Try to get home from getent passwd (may fail on macOS)
    let getentResult: string | null = null
    if (sudoUser) {
      try {
        getentResult = execFileSync('getent', ['passwd', sudoUser], {
          encoding: 'utf-8',
        })
      } catch {
        // getent may not be available on macOS
      }
    }

    const homeDir = resolveHomeDir({
      sudoUser,
      getentResult,
      platform: Platform.Darwin,
      defaultHome: homedir(),
    })

    this.cachedPlatformInfo = {
      platform: Platform.Darwin,
      arch: validateArch(osArch()),
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

  getNullDevice(): string {
    return '/dev/null'
  }

  getExecutableExtension(): string {
    return ''
  }

  async terminateProcess(pid: number, force: boolean): Promise<void> {
    const signal = force ? 'SIGKILL' : 'SIGTERM'
    process.kill(pid, signal)
  }

  isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async findProcessByPort(port: number): Promise<number[]> {
    try {
      const { stdout } = await execAsync(`lsof -ti tcp:${port} 2>/dev/null || true`)
      const pids = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((pid) => parseInt(pid, 10))
        .filter((pid) => !isNaN(pid))
      return pids
    } catch {
      return []
    }
  }

  protected buildToolPath(dir: string, toolName: string): string {
    return `${dir}/${toolName}`
  }
}

class LinuxPlatformService extends BasePlatformService {
  getPlatformInfo(): PlatformInfo {
    if (this.cachedPlatformInfo) return this.cachedPlatformInfo

    const sudoUser = process.env.SUDO_USER || null

    // Try to get home from getent passwd
    let getentResult: string | null = null
    if (sudoUser) {
      try {
        getentResult = execFileSync('getent', ['passwd', sudoUser], {
          encoding: 'utf-8',
        })
      } catch {
        // getent failed
      }
    }

    const homeDir = resolveHomeDir({
      sudoUser,
      getentResult,
      platform: Platform.Linux,
      defaultHome: homedir(),
    })

    // Check if running in WSL
    let isWSL = false
    try {
      const uname = execSync('uname -r', { encoding: 'utf-8' })
      isWSL = uname.toLowerCase().includes('microsoft')
    } catch {
      // Not WSL
    }

    this.cachedPlatformInfo = {
      platform: Platform.Linux,
      arch: validateArch(osArch()),
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

  getNullDevice(): string {
    return '/dev/null'
  }

  getExecutableExtension(): string {
    return ''
  }

  async terminateProcess(pid: number, force: boolean): Promise<void> {
    const signal = force ? 'SIGKILL' : 'SIGTERM'
    process.kill(pid, signal)
  }

  isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async findProcessByPort(port: number): Promise<number[]> {
    try {
      const { stdout } = await execAsync(`lsof -ti tcp:${port} 2>/dev/null || true`)
      const pids = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((pid) => parseInt(pid, 10))
        .filter((pid) => !isNaN(pid))
      return pids
    } catch {
      return []
    }
  }

  protected buildToolPath(dir: string, toolName: string): string {
    return `${dir}/${toolName}`
  }
}

class Win32PlatformService extends BasePlatformService {
  getPlatformInfo(): PlatformInfo {
    if (this.cachedPlatformInfo) return this.cachedPlatformInfo

    this.cachedPlatformInfo = {
      platform: Platform.Win32,
      arch: validateArch(osArch()),
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
    // Timeout for package manager detection (5 seconds)
    const timeout = 5000

    // Try chocolatey
    try {
      await execAsync('choco --version', { timeout })
      return {
        id: 'choco',
        name: 'Chocolatey',
        checkCommand: 'choco --version',
        installTemplate: 'choco install -y {package}',
        updateCommand: 'choco upgrade all',
      }
    } catch {
      // Not chocolatey or timed out
    }

    // Try winget
    try {
      await execAsync('winget --version', { timeout })
      return {
        id: 'winget',
        name: 'Windows Package Manager',
        checkCommand: 'winget --version',
        installTemplate: 'winget install {package}',
        updateCommand: 'winget upgrade --all',
      }
    } catch {
      // Not winget or timed out
    }

    // Try scoop
    try {
      await execAsync('scoop --version', { timeout })
      return {
        id: 'scoop',
        name: 'Scoop',
        checkCommand: 'scoop --version',
        installTemplate: 'scoop install {package}',
        updateCommand: 'scoop update *',
      }
    } catch {
      // Not scoop or timed out
    }

    return null
  }

  getNullDevice(): string {
    return 'NUL'
  }

  getExecutableExtension(): string {
    return '.exe'
  }

  async terminateProcess(pid: number, force: boolean): Promise<void> {
    // On Windows, use taskkill command
    // /T = terminate child processes, /F = force termination
    const args = force ? `/F /PID ${pid} /T` : `/PID ${pid}`
    try {
      await execAsync(`taskkill ${args}`)
    } catch (error) {
      // taskkill exits with error if process doesn't exist, which is fine
      const e = error as { code?: number }
      // Error code 128 means "process not found" which is acceptable
      if (e.code !== 128) {
        throw error
      }
    }
  }

  isProcessRunning(pid: number): boolean {
    try {
      // process.kill with signal 0 works on Windows for checking process existence
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async findProcessByPort(port: number): Promise<number[]> {
    try {
      // Use netstat to find PIDs listening on the port
      // -a = all connections, -n = numeric, -o = owner PID
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`)
      const pids: number[] = []

      // Parse netstat output to find LISTENING processes on this exact port
      // Format: TCP    0.0.0.0:PORT    0.0.0.0:0    LISTENING    PID
      const lines = stdout.trim().split('\n')
      for (const line of lines) {
        // Match lines with LISTENING state on the specific port
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 5 && parts[3] === 'LISTENING') {
          const localAddress = parts[1]
          // Check if this is the exact port (not just containing the port number)
          if (localAddress.endsWith(`:${port}`)) {
            const pid = parseInt(parts[4], 10)
            if (!isNaN(pid) && !pids.includes(pid)) {
              pids.push(pid)
            }
          }
        }
      }

      return pids
    } catch {
      return []
    }
  }

  protected buildToolPath(dir: string, toolName: string): string {
    return `${dir}\\${toolName}.exe`
  }
}

// Create the appropriate platform service for the current OS
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

// Check if running on Windows
export function isWindows(): boolean {
  return process.platform === Platform.Win32
}

/**
 * Get spawn options for Windows shell requirements.
 * Windows needs shell:true for proper command execution with quoted paths.
 */
export function getWindowsSpawnOptions(): { shell?: true } {
  return isWindows() ? { shell: true } : {}
}
