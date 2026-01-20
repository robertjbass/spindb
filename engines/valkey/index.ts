import { spawn, exec, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { valkeyBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  VALKEY_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  type Platform,
  type Arch,
  type ContainerConfig,
  type ProgressCallback,
  type BackupFormat,
  type BackupOptions,
  type BackupResult,
  type RestoreResult,
  type DumpResult,
  type StatusResult,
} from '../../types'

const execAsync = promisify(exec)

const ENGINE = 'valkey'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Shell metacharacters that indicate potential command injection
 * These patterns shouldn't appear in valid Valkey commands
 */
const SHELL_INJECTION_PATTERNS = [
  /;\s*\S/, // Command chaining: ; followed by another command
  /\$\(/, // Command substitution: $(...)
  /\$\{/, // Variable substitution: ${...}
  /`/, // Backtick command substitution
  /&&/, // Logical AND chaining
  /\|\|/, // Logical OR chaining
  /\|\s*\S/, // Pipe to another command
]

// Validate that a command doesn't contain shell injection patterns
function validateCommand(command: string): void {
  for (const pattern of SHELL_INJECTION_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(
        `Command contains shell metacharacters that are not valid in Valkey commands. ` +
          `If you need complex commands, use a script file instead.`,
      )
    }
  }
}

/**
 * Convert a Windows path to Cygwin path format.
 * Valkey Windows binaries are built with Cygwin runtime and expect paths
 * in /cygdrive/c/... format when passed as command-line arguments.
 *
 * Example: C:\Users\foo\config.conf -> /cygdrive/c/Users/foo/config.conf
 */
function toCygwinPath(windowsPath: string): string {
  // Match drive letter at start (e.g., C:\ or D:/)
  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\]/)
  if (!driveMatch) {
    // Not a Windows absolute path, return as-is with forward slashes
    return windowsPath.replace(/\\/g, '/')
  }

  const driveLetter = driveMatch[1].toLowerCase()
  const restOfPath = windowsPath.slice(3).replace(/\\/g, '/')
  return `/cygdrive/${driveLetter}/${restOfPath}`
}

// Build a valkey-cli command for inline command execution
export function buildValkeyCliCommand(
  valkeyCliPath: string,
  port: number,
  command: string,
  options?: { database?: string },
): string {
  // Validate command doesn't contain shell injection patterns
  validateCommand(command)

  const db = options?.database || '0'
  // Escape double quotes consistently on all platforms to prevent shell interpretation issues
  const escaped = command.replace(/"/g, '\\"')
  return `"${valkeyCliPath}" -h 127.0.0.1 -p ${port} -n ${db} ${escaped}`
}

// Generate Valkey configuration file content
function generateValkeyConfig(options: {
  port: number
  dataDir: string
  logFile: string
  pidFile: string
  daemonize?: boolean
}): string {
  // Windows Valkey doesn't support daemonize natively, use detached spawn instead
  const daemonizeValue = options.daemonize ?? true

  // Valkey config requires forward slashes even on Windows
  const normalizePathForValkey = (p: string) => p.replace(/\\/g, '/')

  return `# SpinDB generated Valkey configuration
port ${options.port}
bind 127.0.0.1
dir ${normalizePathForValkey(options.dataDir)}
daemonize ${daemonizeValue ? 'yes' : 'no'}
logfile ${normalizePathForValkey(options.logFile)}
pidfile ${normalizePathForValkey(options.pidFile)}

# Persistence - RDB snapshots
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb

# Append Only File (disabled for local dev)
appendonly no
`
}

export class ValkeyEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Valkey'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // Get platform info for binary operations
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // Fetch available versions from hostdb (dynamically or from cache/fallback)
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // Get binary download URL from hostdb
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // Resolves version string to full version (e.g., '8' -> '8.0.6')
  resolveFullVersion(version: string): string {
    // Check if already a full version (has at least two dots)
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // It's a major version, resolve using version map
    return VALKEY_VERSION_MAP[version] || `${version}.0.0`
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'valkey',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that Valkey binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `valkey-server${ext}`)
    return existsSync(serverPath)
  }

  //Check if a specific Valkey version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return valkeyBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure Valkey binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await valkeyBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binaries in config
    const ext = platformService.getExecutableExtension()
    const tools = ['valkey-server', 'valkey-cli'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * Initialize a new Valkey data directory
   * Creates the directory and generates valkey.conf
   */
  async initDataDir(
    containerName: string,
    _version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })
    const logFile = paths.getContainerLogPath(containerName, { engine: ENGINE })
    const pidFile = join(containerDir, 'valkey.pid')
    const port = (options.port as number) || engineDef.defaultPort

    // Create data directory if it doesn't exist
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created Valkey data directory: ${dataDir}`)
    }

    // Generate valkey.conf
    const configPath = join(containerDir, 'valkey.conf')
    const configContent = generateValkeyConfig({
      port,
      dataDir,
      logFile,
      pidFile,
    })
    await writeFile(configPath, configContent)
    logDebug(`Generated Valkey config: ${configPath}`)

    return dataDir
  }

  // Get the path to valkey-server for a version
  async getValkeyServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'valkey',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `valkey-server${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Valkey ${version} is not installed. Run: spindb engines download valkey ${version}`,
    )
  }

  // Get the path to valkey-cli for a version
  override async getValkeyCliPath(version?: string): Promise<string> {
    // Check config cache first
    const cached = await configManager.getBinaryPath('valkey-cli')
    if (cached && existsSync(cached)) {
      return cached
    }

    // If version provided, use downloaded binary
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'valkey',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const cliPath = join(binPath, 'bin', `valkey-cli${ext}`)
      if (existsSync(cliPath)) {
        return cliPath
      }
    }

    throw new Error(
      'valkey-cli not found. Run: spindb engines download valkey <version>',
    )
  }

  /**
   * Start Valkey server
   * CLI wrapper: valkey-server /path/to/valkey.conf
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version, binaryPath } = container

    // Check if already running (idempotent behavior)
    const alreadyRunning = await processManager.isRunning(name, {
      engine: ENGINE,
    })
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // Use stored binary path if available (from container creation)
    // This ensures version consistency - the container uses the same binary it was created with
    let valkeyServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      // binaryPath is the directory (e.g., ~/.spindb/bin/valkey-8.0.6-linux-arm64)
      // We need to construct the full path to valkey-server
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `valkey-server${ext}`)
      if (existsSync(serverPath)) {
        valkeyServer = serverPath
        logDebug(`Using stored binary path: ${valkeyServer}`)
      }
    }

    // If we didn't find the binary above, fall back to normal path
    if (!valkeyServer) {
      // Get binary from downloaded hostdb binaries
      try {
        valkeyServer = await this.getValkeyServerPath(version)
      } catch (error) {
        // Binary not downloaded yet - this is an orphaned container situation
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Valkey ${version} is not installed. Run: spindb engines download valkey ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    logDebug(`Using valkey-server for version ${version}: ${valkeyServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'valkey.conf')
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'valkey.pid')

    // Windows Valkey doesn't support daemonize natively
    // Use detached spawn on Windows instead, similar to MongoDB
    const useDetachedSpawn = isWindows()

    // Regenerate config with current port (in case it changed)
    const configContent = generateValkeyConfig({
      port,
      dataDir,
      logFile,
      pidFile,
      daemonize: !useDetachedSpawn, // Disable daemonize on Windows
    })
    await writeFile(configPath, configContent)

    onProgress?.({ stage: 'starting', message: 'Starting Valkey...' })

    logDebug(`Starting valkey-server with config: ${configPath}`)

    /**
     * Check log file for port binding errors
     * Returns error message if found, null otherwise
     */
    const checkLogForPortError = async (): Promise<string | null> => {
      try {
        const logContent = await readFile(logFile, 'utf-8')
        const recentLog = logContent.slice(-2000) // Last 2KB

        if (
          recentLog.includes('Address already in use') ||
          recentLog.includes('bind: Address already in use')
        ) {
          return `Port ${port} is already in use (address already in use)`
        }
        if (recentLog.includes('Failed listening on port')) {
          return `Port ${port} is already in use`
        }
      } catch {
        // Log file might not exist yet
      }
      return null
    }

    if (useDetachedSpawn) {
      // Windows: spawn detached process with proper error handling
      // This follows the pattern used by MySQL which works on Windows
      return new Promise((resolve, reject) => {
        const spawnOpts: SpawnOptions = {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
        }

        // Convert Windows path to Cygwin format for Cygwin-built binaries
        const cygwinConfigPath = toCygwinPath(configPath)
        const proc = spawn(valkeyServer, [cygwinConfigPath], spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        // Handle spawn errors (binary not found, DLL issues, etc.)
        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`Failed to spawn Valkey server: ${err.message}`))
        })

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          stdoutOutput += str
          logDebug(`valkey-server stdout: ${str}`)
        })
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          stderrOutput += str
          logDebug(`valkey-server stderr: ${str}`)
        })

        // Detach the process so it continues running after parent exits
        proc.unref()

        // Give spawn a moment to fail if it's going to, then check readiness
        setTimeout(async () => {
          if (settled) return

          // Verify process actually started
          if (!proc.pid) {
            settled = true
            reject(new Error('Valkey server process failed to start (no PID)'))
            return
          }

          // Write PID file for consistency with other engines
          try {
            await writeFile(pidFile, String(proc.pid))
          } catch {
            // Non-fatal - process is running, PID file is for convenience
          }

          // Wait for Valkey to be ready
          const ready = await this.waitForReady(port, version)
          if (settled) return

          if (ready) {
            settled = true
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            settled = true
            const portError = await checkLogForPortError()

            // Read log file content for better error diagnostics
            let logContent = ''
            try {
              logContent = await readFile(logFile, 'utf-8')
            } catch {
              logContent = '(log file not found or empty)'
            }

            const errorDetails = [
              portError || 'Valkey failed to start within timeout.',
              `Binary: ${valkeyServer}`,
              `Config: ${configPath}`,
              `Log file: ${logFile}`,
              `Log content:\n${logContent || '(empty)'}`,
              stderrOutput ? `Stderr:\n${stderrOutput}` : '',
              stdoutOutput ? `Stdout:\n${stdoutOutput}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        }, 500)
      })
    }

    // Unix: Valkey with daemonize: yes handles its own forking
    return new Promise((resolve, reject) => {
      const proc = spawn(valkeyServer, [configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        logDebug(`valkey-server stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        logDebug(`valkey-server stderr: ${data.toString()}`)
      })

      proc.on('error', reject)

      proc.on('close', async (code) => {
        // Valkey with daemonize: yes exits immediately after forking
        // Exit code 0 means the parent forked successfully, but the child may still fail
        if (code === 0 || code === null) {
          // Give the child process a moment to start (or fail)
          await new Promise((r) => setTimeout(r, 500))

          // Check log for early startup failures (like port conflicts)
          const earlyError = await checkLogForPortError()
          if (earlyError) {
            reject(new Error(earlyError))
            return
          }

          // Wait for Valkey to be ready
          const ready = await this.waitForReady(port, version)
          if (ready) {
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            // Check log again for errors if not ready
            const portError = await checkLogForPortError()
            if (portError) {
              reject(new Error(portError))
              return
            }
            reject(
              new Error(
                `Valkey failed to start within timeout. Check logs at: ${logFile}`,
              ),
            )
          }
        } else {
          reject(
            new Error(
              stderr || stdout || `valkey-server exited with code ${code}`,
            ),
          )
        }
      })
    })
  }

  // Wait for Valkey to be ready to accept connections
  // TODO - consider copying the mongodb logic for this
  private async waitForReady(
    port: number,
    version: string,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    let valkeyCli: string
    try {
      valkeyCli = await this.getValkeyCliPathForVersion(version)
    } catch {
      logWarning(
        'valkey-cli not found, cannot verify Valkey is ready. Assuming ready after brief delay.',
      )
      // Give Valkey a moment to start, then assume success
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return true
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        const cmd = `"${valkeyCli}" -h 127.0.0.1 -p ${port} PING`
        const { stdout } = await execAsync(cmd, { timeout: 5000 })
        if (stdout.trim() === 'PONG') {
          logDebug(`Valkey ready on port ${port}`)
          return true
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`Valkey did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop Valkey server
   * Uses SHUTDOWN SAVE via valkey-cli to persist data before stopping
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port, version } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'valkey.pid')

    logDebug(`Stopping Valkey container "${name}" on port ${port}`)

    // Try graceful shutdown via valkey-cli
    const valkeyCli = await this.getValkeyCliPathForVersion(version)
    if (valkeyCli) {
      try {
        const cmd = `"${valkeyCli}" -h 127.0.0.1 -p ${port} SHUTDOWN SAVE`
        await execAsync(cmd, { timeout: 10000 })
        logDebug('Valkey shutdown command sent')
        // Wait a bit for process to exit
        await new Promise((resolve) => setTimeout(resolve, 2000))
      } catch (error) {
        logDebug(`valkey-cli shutdown failed: ${error}`)
        // Continue to PID-based shutdown
      }
    }

    // Get PID and force kill if needed
    let pid: number | null = null

    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // Ignore
      }
    }

    // Kill process if still running
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing Valkey process ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        await new Promise((resolve) => setTimeout(resolve, 2000))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`Graceful termination failed, force killing ${pid}`)
          await platformService.terminateProcess(pid, true)
        }
      } catch (error) {
        logDebug(`Process termination error: ${error}`)
      }
    }

    // Cleanup PID file
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // Ignore
      }
    }

    logDebug('Valkey stopped')
  }

  // Get Valkey server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port, version } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'valkey.pid')

    // Try pinging with valkey-cli
    const valkeyCli = await this.getValkeyCliPathForVersion(version)
    if (valkeyCli) {
      try {
        const cmd = `"${valkeyCli}" -h 127.0.0.1 -p ${port} PING`
        const { stdout } = await execAsync(cmd, { timeout: 5000 })
        if (stdout.trim() === 'PONG') {
          return { running: true, message: 'Valkey is running' }
        }
      } catch {
        // Not responding, check PID
      }
    }

    // Check PID file
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
          return {
            running: true,
            message: `Valkey is running (PID: ${pid})`,
          }
        }
      } catch {
        // Ignore
      }
    }

    return { running: false, message: 'Valkey is not running' }
  }

  // Detect backup format
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup
   * IMPORTANT: Valkey must be stopped before restore
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name, port } = container
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })

    return restoreBackup(backupPath, {
      containerName: name,
      dataDir,
      port,
      database: options.database || container.database || '0',
      flush: options.flush,
    })
  }

  /**
   * Get connection string
   * Format: redis://127.0.0.1:PORT/DATABASE
   * (Uses redis:// scheme for client compatibility)
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || '0'
    return `redis://127.0.0.1:${port}/${db}`
  }

  /**
   * Get path to valkey-cli for a specific version
   * @param version - Optional version (e.g., "8", "9"). If not provided, uses cached path.
   * @deprecated Use getValkeyCliPath() instead
   */
  async getValkeyCliPathForVersion(version?: string): Promise<string> {
    return this.getValkeyCliPath(version)
  }

  // Open valkey-cli interactive shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port, version } = container
    const db = database || container.database || '0'

    const valkeyCli = await this.getValkeyCliPathForVersion(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        valkeyCli,
        ['-h', '127.0.0.1', '-p', String(port), '-n', db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  // Get path to iredis (enhanced CLI) if installed
  // Note: iredis works with Valkey since it's protocol-compatible
  private async getIredisPath(): Promise<string | null> {
    // Check config cache first
    const cached = await configManager.getBinaryPath('iredis')
    if (cached && existsSync(cached)) {
      return cached
    }

    // Check system PATH
    const systemPath = await platformService.findToolPath('iredis')
    if (systemPath) {
      return systemPath
    }

    return null
  }

  // Connect with iredis (enhanced CLI)
  async connectWithIredis(
    container: ContainerConfig,
    database?: string,
  ): Promise<void> {
    const { port } = container
    const db = database || container.database || '0'

    const iredis = await this.getIredisPath()
    if (!iredis) {
      throw new Error(
        'iredis not found. Install it with:\n' +
          '  macOS: brew install iredis\n' +
          '  pip: pip install iredis',
      )
    }

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        iredis,
        ['-h', '127.0.0.1', '-p', String(port), '-n', db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * Create a new database
   * Valkey uses numbered databases (0-15), they always exist
   * This is effectively a no-op
   */
  async createDatabase(
    _container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const dbNum = parseInt(database, 10)
    if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
      throw new Error(
        `Invalid Valkey database number: ${database}. Must be 0-15.`,
      )
    }
    // No-op - Valkey databases always exist
    logDebug(
      `Valkey database ${database} is available (databases 0-15 always exist)`,
    )
  }

  /**
   * Drop a database
   * Uses FLUSHDB to clear all keys in the specified database
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port, version } = container
    const dbNum = parseInt(database, 10)
    if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
      throw new Error(
        `Invalid Valkey database number: ${database}. Must be 0-15.`,
      )
    }

    const valkeyCli = await this.getValkeyCliPathForVersion(version)

    // SELECT the database and FLUSHDB
    const cmd = `"${valkeyCli}" -h 127.0.0.1 -p ${port} -n ${database} FLUSHDB`

    try {
      await execAsync(cmd, { timeout: 10000 })
      logDebug(`Flushed Valkey database ${database}`)
    } catch (error) {
      const err = error as Error
      logDebug(`FLUSHDB failed: ${err.message}`)
      throw new Error(
        `Failed to flush Valkey database ${database}: ${err.message}`,
      )
    }
  }

  /**
   * Get the memory usage of the Valkey server in bytes
   *
   * NOTE: Valkey does not provide per-database memory statistics.
   * This returns the total server memory (used_memory from INFO memory),
   * not the size of a specific numbered database (0-15).
   * This is acceptable for SpinDB since each container runs one Valkey server.
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, version } = container

    try {
      const valkeyCli = await this.getValkeyCliPathForVersion(version)
      // INFO memory returns server-wide stats (database selection has no effect)
      const cmd = `"${valkeyCli}" -h 127.0.0.1 -p ${port} INFO memory`

      const { stdout } = await execAsync(cmd, { timeout: 10000 })

      // Parse used_memory (total server memory) from INFO output
      const match = stdout.match(/used_memory:(\d+)/)
      if (match) {
        return parseInt(match[1], 10)
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote Valkey connection
   * Valkey doesn't support remote dump like pg_dump/mongodump
   * Throw an error with guidance
   */
  async dumpFromConnectionString(
    _connectionString: string,
    _outputPath: string,
  ): Promise<DumpResult> {
    throw new Error(
      'Valkey does not support creating containers from remote connection strings.\n' +
        'To migrate data from a remote Valkey instance:\n' +
        '  1. On remote server: valkey-cli --rdb dump.rdb\n' +
        '  2. Copy dump.rdb to local machine\n' +
        '  3. spindb restore <container> dump.rdb',
    )
  }

  // Create a backup
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  // Run a Valkey command file or inline command
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port, version } = container
    const db = options.database || container.database || '0'

    const valkeyCli = await this.getValkeyCliPathForVersion(version)

    if (options.file) {
      // Read file and pipe to valkey-cli via stdin (avoids shell interpolation issues)
      const fileContent = await readFile(options.file, 'utf-8')
      const args = ['-h', '127.0.0.1', '-p', String(port), '-n', db]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(valkeyCli, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })

        let rejected = false

        proc.on('error', (err) => {
          rejected = true
          reject(err)
        })

        proc.on('close', (code) => {
          if (rejected) return
          if (code === 0 || code === null) {
            resolve()
          } else {
            reject(new Error(`valkey-cli exited with code ${code}`))
          }
        })

        // Write file content to stdin and close it
        proc.stdin?.write(fileContent)
        proc.stdin?.end()
      })
    } else if (options.sql) {
      // Run inline command by piping to valkey-cli stdin (avoids shell quoting issues on Windows)
      const args = ['-h', '127.0.0.1', '-p', String(port), '-n', db]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(valkeyCli, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })

        let rejected = false

        proc.on('error', (err) => {
          rejected = true
          reject(err)
        })

        proc.on('close', (code) => {
          if (rejected) return
          if (code === 0 || code === null) {
            resolve()
          } else {
            reject(new Error(`valkey-cli exited with code ${code}`))
          }
        })

        // Write command to stdin and close it
        proc.stdin?.write(options.sql + '\n')
        proc.stdin?.end()
      })
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }
}

export const valkeyEngine = new ValkeyEngine()
