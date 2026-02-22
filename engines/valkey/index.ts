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
import {
  logDebug,
  logWarning,
  assertValidUsername,
} from '../../core/error-handler'
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
import { getValkeyCliPath, VALKEY_CLI_NOT_FOUND_ERROR } from './cli-utils'
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
  type QueryResult,
  type QueryOptions,
  type CreateUserOptions,
  type UserCredentials,
} from '../../types'
import { parseRedisResult } from '../../core/query-parser'
import { getLibraryEnv, detectLibraryError } from '../../core/library-env'

const execAsync = promisify(exec)

const ENGINE = 'valkey'

/**
 * Escape a Valkey key for use in CLI commands.
 * Escapes backslashes, double quotes, and control characters to prevent
 * command injection and ensure keys are parsed correctly by the CLI.
 */
function escapeKeyForCommand(key: string): string {
  return key
    .replace(/\\/g, '\\\\') // Backslashes first to prevent double-escaping
    .replace(/"/g, '\\"') // Double quotes
    .replace(/\n/g, '\\n') // Newline
    .replace(/\r/g, '\\r') // Carriage return
    .replace(/\t/g, '\\t') // Tab
}
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

/**
 * Parse a Valkey connection string
 * Supported schemes:
 * - redis://   (plain, no TLS)
 * - rediss://  (TLS enabled)
 * - valkey://  (plain, no TLS)
 * - valkeys:// (TLS enabled)
 *
 * Format: scheme://[user:password@]host[:port][/database]
 *
 * Examples:
 * - redis://localhost:6379
 * - rediss://secure.host:6379/0  (TLS)
 * - valkey://localhost:6379
 * - valkeys://secure.host:6379   (TLS)
 */
function parseValkeyConnectionString(connectionString: string): {
  host: string
  port: number
  username: string | undefined
  password: string | undefined
  database: number
  tls: boolean
} {
  let url: URL

  const normalized = connectionString.trim()

  // Check for valid schemes
  const validSchemes = ['redis://', 'rediss://', 'valkey://', 'valkeys://']
  const hasValidScheme = validSchemes.some((scheme) =>
    normalized.startsWith(scheme),
  )

  if (!hasValidScheme) {
    throw new Error(
      `Invalid Valkey connection string: ${connectionString}\n` +
        'Expected format: scheme://[user:password@]host:port[/database]\n' +
        'Supported schemes: redis://, rediss://, valkey://, valkeys://\n' +
        '(Use rediss:// or valkeys:// for TLS connections)',
    )
  }

  // Normalize valkey(s):// to redis(s):// for URL parsing
  let urlString = normalized
  if (normalized.startsWith('valkeys://')) {
    urlString = normalized.replace('valkeys://', 'rediss://')
  } else if (normalized.startsWith('valkey://')) {
    urlString = normalized.replace('valkey://', 'redis://')
  }

  try {
    url = new URL(urlString)
  } catch {
    throw new Error(
      `Invalid Valkey connection string: ${connectionString}\n` +
        'Expected format: scheme://[user:password@]host:port[/database]',
    )
  }

  // Determine TLS based on original scheme
  const tls =
    normalized.startsWith('rediss://') || normalized.startsWith('valkeys://')

  const host = url.hostname || 'localhost'
  const port = parseInt(url.port, 10) || 6379

  // Valkey supports ACL with usernames (inherited from Redis 6.0+)
  // Format: redis://username:password@host:port/db
  const username = url.username || undefined
  const password = url.password || undefined

  // Database is in the path (e.g., /5 means database 5)
  let database = 0
  if (url.pathname && url.pathname !== '/') {
    const dbNum = parseInt(url.pathname.replace('/', ''), 10)
    if (!isNaN(dbNum)) {
      if (dbNum < 0 || dbNum > 15) {
        throw new RangeError(
          `Invalid Valkey database number: ${dbNum} (from path "${url.pathname}").\n` +
            'Valkey databases must be 0-15.',
        )
      }
      database = dbNum
    }
  }

  return { host, port, username, password, database, tls }
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

# Suppress ARM64 copy-on-write warning with Transparent Huge Pages.
# Redis/Valkey refuses to start on ARM64 with THP enabled unless this is set.
# Safe for local development (SpinDB's use case).
ignore-warnings ARM64-COW-BUG
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

    // Compute library fallback paths from the binary directory
    const binBaseDir = binaryPath || this.getBinaryPath(version)
    const libraryEnv = getLibraryEnv(binBaseDir)

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
          env: { ...process.env, ...libraryEnv },
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
            // On Windows, Cygwin binaries may fork internally, making proc.pid stale.
            // Find the actual PID by port and update the PID file (same pattern as QuestDB).
            try {
              const pids = await platformService.findProcessByPort(port)
              if (pids.length > 0 && pids[0] !== proc.pid) {
                logDebug(
                  `Valkey actual PID ${pids[0]} differs from spawn PID ${proc.pid}, updating PID file`,
                )
                await writeFile(pidFile, String(pids[0]))
              }
            } catch {
              // Non-fatal - PID file already has proc.pid from earlier write
            }

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

            // Check for library loading errors first
            const libError = detectLibraryError(
              stderrOutput + logContent,
              'Valkey',
            )
            if (libError) {
              reject(new Error(libError))
              return
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
        env: { ...process.env, ...libraryEnv },
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

            // Check for library loading errors
            let logContent = ''
            try {
              logContent = await readFile(logFile, 'utf-8')
            } catch {
              logContent = ''
            }
            const libError = detectLibraryError(stderr + logContent, 'Valkey')
            if (libError) {
              reject(new Error(libError))
              return
            }

            reject(
              new Error(
                `Valkey failed to start within timeout. Check logs at: ${logFile}`,
              ),
            )
          }
        } else {
          // Check for library loading errors on non-zero exit
          const libError = detectLibraryError(stderr || stdout, 'Valkey')
          if (libError) {
            reject(new Error(libError))
            return
          }
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
    timeoutMs = 60000,
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
   * Creates a text-format backup by scanning all keys from the remote server
   *
   * Connection string format: redis://[user:password@]host:port[/db]
   * Note: Uses redis:// scheme for compatibility (Valkey is Redis-compatible)
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const valkeyCli = await getValkeyCliPath()
    if (!valkeyCli) {
      throw new Error(VALKEY_CLI_NOT_FOUND_ERROR)
    }

    // Parse connection string (uses redis:// for compatibility)
    const { host, port, username, password, database, tls } =
      parseValkeyConnectionString(connectionString)

    logDebug(
      `Connecting to remote Valkey at ${host}:${port} (db: ${database}, tls: ${tls})`,
    )

    // Build CLI args for remote connection (password passed via env var for security)
    const buildArgs = (): string[] => {
      const args = ['-h', host, '-p', String(port)]
      // ACL: pass username via --user flag (inherited from Redis 6.0+)
      if (username) {
        args.push('--user', username)
      }
      // Enable TLS for rediss:// or valkeys:// schemes
      if (tls) {
        args.push('--tls')
      }
      // Note: password is passed via REDISCLI_AUTH env var, not command line
      args.push('-n', String(database))
      return args
    }

    // Execute a Valkey command on the remote server with timeout
    const execRemote = async (
      command: string,
      timeoutMs = 30000,
    ): Promise<string> => {
      return new Promise((resolve, reject) => {
        const args = buildArgs()
        // Pass password via REDISCLI_AUTH env var to avoid exposing it in process listings
        const env = password
          ? { ...process.env, REDISCLI_AUTH: password }
          : process.env
        const proc = spawn(valkeyCli, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        })

        let stdout = ''
        let stderr = ''
        let settled = false

        // Timeout handler to prevent hanging
        const timeoutId = setTimeout(() => {
          if (settled) return
          settled = true
          proc.kill()
          reject(
            new Error(
              `Command timed out after ${timeoutMs}ms: ${command.slice(0, 50)}...`,
            ),
          )
        }, timeoutMs)

        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          reject(err)
        })

        proc.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          // Ignore auth-related warnings in stderr (password provided via REDISCLI_AUTH)
          if (code === 0 || code === null) {
            resolve(stdout)
          } else {
            reject(new Error(stderr || `valkey-cli exited with code ${code}`))
          }
        })

        proc.stdin.write(command + '\n')
        proc.stdin.end()
      })
    }

    // Test connectivity
    try {
      const pingResult = await execRemote('PING')
      if (!pingResult.trim().includes('PONG')) {
        throw new Error(`Unexpected PING response: ${pingResult.trim()}`)
      }
    } catch (error) {
      throw new Error(
        `Failed to connect to Valkey at ${host}:${port}: ${(error as Error).message}`,
      )
    }

    // Build text backup from remote keys
    const commands: string[] = []
    commands.push('# Valkey backup generated by SpinDB')
    commands.push(`# Source: ${host}:${port}`)
    commands.push(`# Date: ${new Date().toISOString()}`)
    commands.push('')

    // WARNING: KEYS * blocks the Valkey server during execution.
    // This is acceptable for small datasets but will cause performance issues
    // on large databases. For production use with large datasets, consider
    // implementing SCAN-based iteration instead.
    // TODO: Replace with SCAN iterator for large dataset support
    const keysOutput = await execRemote('KEYS *')
    const keys = keysOutput
      .trim()
      .split(/\r?\n/)
      .map((k) => k.trim())
      .filter((k) => k)

    logDebug(`Found ${keys.length} keys on remote Valkey`)

    // Warn about large key counts that may cause performance issues
    if (keys.length > 10000) {
      logWarning(
        `Large key count detected: ${keys.length} keys. ` +
          'This operation may be slow. Consider using SCAN-based iteration for production workloads.',
      )
    }

    // TODO: Optimize with pipelining or Lua script to batch TYPE/TTL/value fetches
    // Currently makes O(3N) round trips which is slow for large datasets.
    // A pipelined approach could fetch all data in fewer round trips.

    for (const key of keys) {
      // Get key type
      const typeOutput = await execRemote(`TYPE "${escapeKeyForCommand(key)}"`)
      const keyType = typeOutput.trim()

      // Get TTL
      const ttlOutput = await execRemote(`TTL "${escapeKeyForCommand(key)}"`)
      const ttl = parseInt(ttlOutput.trim(), 10)

      // Quote the key for output commands if it contains special chars
      const quotedKey =
        key.includes(' ') || /[*?[\]{}$`"'\\!<>|;&()]/.test(key)
          ? `"${key.replace(/"/g, '\\"')}"`
          : key

      // Redis-cli compatible double-quote escaping for values
      // Escapes backslashes and double quotes, converts newlines to \n sequences
      // Note: This approach doesn't handle binary data.
      // For binary-safe backups, consider using DUMP/RESTORE commands instead.
      const escapeValue = (value: string): string => {
        const escaped = value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
        return `"${escaped}"`
      }

      // Strip only trailing newline from execRemote output, preserving intentional whitespace
      const stripTrailingNewline = (s: string): string =>
        s.replace(/\r?\n$/, '')

      switch (keyType) {
        case 'string': {
          const value = await execRemote(`GET "${escapeKeyForCommand(key)}"`)
          commands.push(
            `SET ${quotedKey} ${escapeValue(stripTrailingNewline(value))}`,
          )
          break
        }
        case 'hash': {
          const hashData = await execRemote(
            `HGETALL "${escapeKeyForCommand(key)}"`,
          )
          const lines = stripTrailingNewline(hashData)
            .split(/\r?\n/)
            .filter((l) => l)
          if (lines.length >= 2) {
            const pairs: string[] = []
            // Handle odd number of lines (incomplete field/value pair)
            const completeCount = lines.length - (lines.length % 2)
            if (lines.length % 2 !== 0) {
              logWarning(
                `Hash ${quotedKey} has incomplete field/value pair, skipping last field`,
              )
            }
            for (let i = 0; i < completeCount; i += 2) {
              const field = lines[i]
              const value = lines[i + 1]
              const quotedField =
                field.includes(' ') || /[*?[\]{}$`"'\\!<>|;&()]/.test(field)
                  ? `"${field.replace(/"/g, '\\"')}"`
                  : field
              pairs.push(`${quotedField} ${escapeValue(value)}`)
            }
            if (pairs.length > 0) {
              commands.push(`HSET ${quotedKey} ${pairs.join(' ')}`)
            }
          }
          break
        }
        case 'list': {
          const listData = await execRemote(
            `LRANGE "${escapeKeyForCommand(key)}" 0 -1`,
          )
          const items = stripTrailingNewline(listData)
            .split(/\r?\n/)
            .filter((l) => l)
          if (items.length > 0) {
            const escapedItems = items.map((item) => escapeValue(item))
            commands.push(`RPUSH ${quotedKey} ${escapedItems.join(' ')}`)
          }
          break
        }
        case 'set': {
          const setData = await execRemote(
            `SMEMBERS "${escapeKeyForCommand(key)}"`,
          )
          const members = stripTrailingNewline(setData)
            .split(/\r?\n/)
            .filter((l) => l)
          if (members.length > 0) {
            const escapedMembers = members.map((m) => escapeValue(m))
            commands.push(`SADD ${quotedKey} ${escapedMembers.join(' ')}`)
          }
          break
        }
        case 'zset': {
          const zsetData = await execRemote(
            `ZRANGE "${escapeKeyForCommand(key)}" 0 -1 WITHSCORES`,
          )
          const lines = stripTrailingNewline(zsetData)
            .split(/\r?\n/)
            .filter((l) => l)
          if (lines.length >= 2) {
            const pairs: string[] = []
            // Handle odd number of lines (incomplete member/score pair)
            const completeCount = lines.length - (lines.length % 2)
            if (lines.length % 2 !== 0) {
              logWarning(
                `ZSet ${quotedKey} has odd line count, skipping incomplete entry: ${lines[lines.length - 1]}`,
              )
            }
            for (let i = 0; i < completeCount; i += 2) {
              const member = lines[i]
              const score = lines[i + 1]
              pairs.push(`${score} ${escapeValue(member)}`)
            }
            if (pairs.length > 0) {
              commands.push(`ZADD ${quotedKey} ${pairs.join(' ')}`)
            }
          }
          break
        }
        default:
          logWarning(`Skipping key ${key} with unsupported type: ${keyType}`)
      }

      // Add EXPIRE if key has TTL
      if (ttl > 0) {
        commands.push(`EXPIRE ${quotedKey} ${ttl}`)
      }
    }

    // Write commands to file
    const content = commands.join('\n') + '\n'
    await writeFile(outputPath, content, 'utf-8')

    return {
      filePath: outputPath,
      warnings:
        keys.length === 0 ? ['Remote Valkey database is empty'] : undefined,
    }
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

  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port, version } = container
    const db = options?.database || container.database || '0'
    const host = options?.host ?? '127.0.0.1'

    const valkeyCli = await this.getValkeyCliPathForVersion(version)

    return new Promise((resolve, reject) => {
      const args = ['-h', host, '-p', String(port), '-n', db, '--raw']

      if (options?.username) {
        args.push('--user', options.username)
      }
      if (options?.ssl) {
        args.push('--tls')
      }

      // Pass password via REDISCLI_AUTH env to avoid exposing it in process listings
      const env = options?.password
        ? { ...process.env, REDISCLI_AUTH: options.password }
        : process.env

      const proc = spawn(valkeyCli, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('error', reject)

      proc.on('close', (code) => {
        if (code === 0 || code === null) {
          // Use Redis parser since Valkey is Redis-compatible
          resolve(parseRedisResult(stdout, query))
        } else {
          reject(new Error(stderr || `valkey-cli exited with code ${code}`))
        }
      })

      // Write command to stdin and close it
      proc.stdin?.write(query + '\n')
      proc.stdin?.end()
    })
  }

  /**
   * List databases for Valkey.
   * Valkey uses numbered databases (0-15 by default), not named databases.
   * Returns the configured database number as a single-item array.
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    // Valkey has numbered databases, not named ones
    // Return the container's configured database
    return [container.database]
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password } = options
    assertValidUsername(username)
    const { port, version } = container
    const db = options.database ?? container.database ?? '0'
    const valkeyCli = await this.getValkeyCliPath(version)

    // Reject passwords with characters that break ACL SETUSER syntax:
    // '>' sets password, '#' sets hash, '<' removes password — all are ACL delimiters.
    // Whitespace and newlines would split the command unexpectedly.
    if (/[>#<\s\n\r]/.test(password)) {
      throw new Error(
        'Password contains invalid characters for Valkey ACL. Passwords must not contain ">", "#", "<", whitespace, or newlines.',
      )
    }

    // ACL SETUSER is idempotent - sets user with full access
    // Send ACL command via stdin to avoid leaking password in process argv
    const cliArgs = ['-h', '127.0.0.1', '-p', String(port), '-n', db]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(valkeyCli, cliArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Failed to create user: ${stderr}`))
      })
      proc.on('error', reject)

      proc.stdin?.write(`ACL SETUSER ${username} on >${password} ~* &* +@all\n`)
      proc.stdin?.end()
    })
    logDebug(`Created Valkey user: ${username}`)

    // Valkey uses redis:// scheme for compatibility
    const connectionString = `redis://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`

    return {
      username,
      password,
      connectionString,
      engine: container.engine,
      container: container.name,
      database: db,
    }
  }
}

export const valkeyEngine = new ValkeyEngine()
