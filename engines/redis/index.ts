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
import { redisBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  REDIS_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { getRedisCliPath, REDIS_CLI_NOT_FOUND_ERROR } from './cli-utils'
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

const execAsync = promisify(exec)

const ENGINE = 'redis'

/**
 * Escape a Redis key for use in CLI commands.
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
 * These patterns shouldn't appear in valid Redis commands
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
        `Command contains shell metacharacters that are not valid in Redis commands. ` +
          `If you need complex commands, use a script file instead.`,
      )
    }
  }
}

/**
 * Convert a Windows path to Cygwin path format.
 * Redis Windows binaries (from redis-windows) are built with MSYS2/Cygwin runtime
 * and expect paths in /cygdrive/c/... format when passed as command-line arguments.
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
 * Parse a Redis connection string
 * Supported schemes:
 * - redis://   (plain, no TLS)
 * - rediss://  (TLS enabled)
 *
 * Format: scheme://[user:password@]host[:port][/database]
 *
 * Examples:
 * - redis://localhost:6379
 * - rediss://secure.host:6379/0  (TLS)
 * - redis://:password@localhost:6379/0
 * - redis://user:password@remote.host:6380/5
 */
function parseRedisConnectionString(connectionString: string): {
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
  const validSchemes = ['redis://', 'rediss://']
  const hasValidScheme = validSchemes.some((scheme) =>
    normalized.startsWith(scheme),
  )

  if (!hasValidScheme) {
    throw new Error(
      `Invalid Redis connection string: ${connectionString}\n` +
        'Expected format: scheme://[user:password@]host:port[/database]\n' +
        'Supported schemes: redis://, rediss://\n' +
        '(Use rediss:// for TLS connections)',
    )
  }

  try {
    url = new URL(normalized)
  } catch {
    throw new Error(
      `Invalid Redis connection string: ${connectionString}\n` +
        'Expected format: scheme://[user:password@]host:port[/database]',
    )
  }

  // Determine TLS based on scheme
  const tls = normalized.startsWith('rediss://')

  const host = url.hostname || 'localhost'
  const port = parseInt(url.port, 10) || 6379

  // Redis 6.0+ supports ACL with usernames
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
          `Invalid Redis database number: ${dbNum} (from path "${url.pathname}").\n` +
            'Redis databases must be 0-15 by default.\n' +
            'If your server is configured with more databases (via the "databases" setting),\n' +
            'you may need to increase the limit in server configuration.',
        )
      }
      database = dbNum
    }
  }

  return { host, port, username, password, database, tls }
}

// Build a redis-cli command for inline command execution
export function buildRedisCliCommand(
  redisCliPath: string,
  port: number,
  command: string,
  options?: { database?: string },
): string {
  // Validate command doesn't contain shell injection patterns
  validateCommand(command)

  const db = options?.database || '0'
  // Escape double quotes consistently on all platforms to prevent shell interpretation issues
  const escaped = command.replace(/"/g, '\\"')
  return `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${db} ${escaped}`
}

// Generate Redis configuration file content
function generateRedisConfig(options: {
  port: number
  dataDir: string
  logFile: string
  pidFile: string
  daemonize?: boolean
}): string {
  // Windows Redis doesn't support daemonize natively, use detached spawn instead
  const daemonizeValue = options.daemonize ?? true

  // Redis config requires forward slashes even on Windows
  const normalizePathForRedis = (p: string) => p.replace(/\\/g, '/')

  return `# SpinDB generated Redis configuration
port ${options.port}
bind 127.0.0.1
dir ${normalizePathForRedis(options.dataDir)}
daemonize ${daemonizeValue ? 'yes' : 'no'}
logfile ${normalizePathForRedis(options.logFile)}
pidfile ${normalizePathForRedis(options.pidFile)}

# Persistence - RDB snapshots
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb

# Append Only File (disabled for local dev)
appendonly no
`
}

export class RedisEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Redis'
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

  // Resolves version string to full version (e.g., '8' -> '8.4.0')
  resolveFullVersion(version: string): string {
    // Check if already a full version (has at least two dots)
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // It's a major version, resolve using version map
    return REDIS_VERSION_MAP[version] || `${version}.0.0`
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that Redis binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `redis-server${ext}`)
    return existsSync(serverPath)
  }

  //Check if a specific Redis version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return redisBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure Redis binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await redisBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binaries in config
    const ext = platformService.getExecutableExtension()
    const tools = ['redis-server', 'redis-cli'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * Initialize a new Redis data directory
   * Creates the directory and generates redis.conf
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
    const pidFile = join(containerDir, 'redis.pid')
    const port = (options.port as number) || engineDef.defaultPort

    // Create data directory if it doesn't exist
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created Redis data directory: ${dataDir}`)
    }

    // Generate redis.conf
    const configPath = join(containerDir, 'redis.conf')
    const configContent = generateRedisConfig({
      port,
      dataDir,
      logFile,
      pidFile,
    })
    await writeFile(configPath, configContent)
    logDebug(`Generated Redis config: ${configPath}`)

    return dataDir
  }

  // Get the path to redis-server for a version
  async getRedisServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `redis-server${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Redis ${version} is not installed. Run: spindb engines download redis ${version}`,
    )
  }

  // Get the path to redis-cli for a version
  override async getRedisCliPath(version?: string): Promise<string> {
    // Check config cache first
    const cached = await configManager.getBinaryPath('redis-cli')
    if (cached && existsSync(cached)) {
      return cached
    }

    // If version provided, use downloaded binary
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'redis',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const cliPath = join(binPath, 'bin', `redis-cli${ext}`)
      if (existsSync(cliPath)) {
        return cliPath
      }
    }

    throw new Error(
      'redis-cli not found. Run: spindb engines download redis <version>',
    )
  }

  /**
   * Start Redis server
   * CLI wrapper: redis-server /path/to/redis.conf
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
    let redisServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      // binaryPath is the directory (e.g., ~/.spindb/bin/redis-8.4.0-linux-arm64)
      // We need to construct the full path to redis-server
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `redis-server${ext}`)
      if (existsSync(serverPath)) {
        redisServer = serverPath
        logDebug(`Using stored binary path: ${redisServer}`)
      }
    }

    // If we didn't find the binary above, fall back to normal path
    if (!redisServer) {
      // Get binary from downloaded hostdb binaries
      try {
        redisServer = await this.getRedisServerPath(version)
      } catch (error) {
        // Binary not downloaded yet - this is an orphaned container situation
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Redis ${version} is not installed. Run: spindb engines download redis ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    logDebug(`Using redis-server for version ${version}: ${redisServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'redis.conf')
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'redis.pid')

    // Windows Redis doesn't support daemonize natively
    // Use detached spawn on Windows instead, similar to MongoDB
    const useDetachedSpawn = isWindows()

    // Regenerate config with current port (in case it changed)
    const configContent = generateRedisConfig({
      port,
      dataDir,
      logFile,
      pidFile,
      daemonize: !useDetachedSpawn, // Disable daemonize on Windows
    })
    await writeFile(configPath, configContent)

    onProgress?.({ stage: 'starting', message: 'Starting Redis...' })

    logDebug(`Starting redis-server with config: ${configPath}`)

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

        // Convert Windows path to Cygwin format for MSYS2/Cygwin-built binaries
        const cygwinConfigPath = toCygwinPath(configPath)
        const proc = spawn(redisServer, [cygwinConfigPath], spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        // Handle spawn errors (binary not found, DLL issues, etc.)
        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`Failed to spawn Redis server: ${err.message}`))
        })

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          stdoutOutput += str
          logDebug(`redis-server stdout: ${str}`)
        })
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          stderrOutput += str
          logDebug(`redis-server stderr: ${str}`)
        })

        // Detach the process so it continues running after parent exits
        proc.unref()

        // Give spawn a moment to fail if it's going to, then check readiness
        setTimeout(async () => {
          if (settled) return

          // Verify process actually started
          if (!proc.pid) {
            settled = true
            reject(new Error('Redis server process failed to start (no PID)'))
            return
          }

          // Write PID file for consistency with other engines
          try {
            await writeFile(pidFile, String(proc.pid))
          } catch {
            // Non-fatal - process is running, PID file is for convenience
          }

          // Wait for Redis to be ready
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
              portError || 'Redis failed to start within timeout.',
              `Binary: ${redisServer}`,
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

    // Unix: Redis with daemonize: yes handles its own forking
    return new Promise((resolve, reject) => {
      const proc = spawn(redisServer, [configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        logDebug(`redis-server stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        logDebug(`redis-server stderr: ${data.toString()}`)
      })

      proc.on('error', reject)

      proc.on('close', async (code) => {
        // Redis with daemonize: yes exits immediately after forking
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

          // Wait for Redis to be ready
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
                `Redis failed to start within timeout. Check logs at: ${logFile}`,
              ),
            )
          }
        } else {
          reject(
            new Error(
              stderr || stdout || `redis-server exited with code ${code}`,
            ),
          )
        }
      })
    })
  }

  // Wait for Redis to be ready to accept connections
  private async waitForReady(
    port: number,
    version: string,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    let redisCli: string
    try {
      redisCli = await this.getRedisCliPathForVersion(version)
    } catch {
      logWarning('redis-cli not found, cannot verify Redis is ready')
      return false
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        const cmd = `"${redisCli}" -h 127.0.0.1 -p ${port} PING`
        const { stdout } = await execAsync(cmd, { timeout: 5000 })
        if (stdout.trim() === 'PONG') {
          logDebug(`Redis ready on port ${port}`)
          return true
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`Redis did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop Redis server
   * Uses SHUTDOWN SAVE via redis-cli to persist data before stopping
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port, version } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'redis.pid')

    logDebug(`Stopping Redis container "${name}" on port ${port}`)

    // Try graceful shutdown via redis-cli
    const redisCli = await this.getRedisCliPathForVersion(version)
    if (redisCli) {
      try {
        const cmd = `"${redisCli}" -h 127.0.0.1 -p ${port} SHUTDOWN SAVE`
        await execAsync(cmd, { timeout: 10000 })
        logDebug('Redis shutdown command sent')
        // Wait a bit for process to exit
        await new Promise((resolve) => setTimeout(resolve, 2000))
      } catch (error) {
        logDebug(`redis-cli shutdown failed: ${error}`)
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
      logDebug(`Killing Redis process ${pid}`)
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

    logDebug('Redis stopped')
  }

  // Get Redis server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port, version } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'redis.pid')

    // Try pinging with redis-cli
    const redisCli = await this.getRedisCliPathForVersion(version)
    if (redisCli) {
      try {
        const cmd = `"${redisCli}" -h 127.0.0.1 -p ${port} PING`
        const { stdout } = await execAsync(cmd, { timeout: 5000 })
        if (stdout.trim() === 'PONG') {
          return { running: true, message: 'Redis is running' }
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
            message: `Redis is running (PID: ${pid})`,
          }
        }
      } catch {
        // Ignore
      }
    }

    return { running: false, message: 'Redis is not running' }
  }

  // Detect backup format
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup
   * IMPORTANT: Redis must be stopped before restore
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
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || '0'
    return `redis://127.0.0.1:${port}/${db}`
  }

  /**
   * Get path to redis-cli for a specific version
   * @param version - Optional version (e.g., "8", "7"). If not provided, uses cached path.
   * @deprecated Use getRedisCliPath() instead
   */
  async getRedisCliPathForVersion(version?: string): Promise<string> {
    return this.getRedisCliPath(version)
  }

  // Open redis-cli interactive shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port, version } = container
    const db = database || container.database || '0'

    const redisCli = await this.getRedisCliPathForVersion(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        redisCli,
        ['-h', '127.0.0.1', '-p', String(port), '-n', db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  // Get path to iredis (enhanced CLI) if installed
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
   * Redis uses numbered databases (0-15), they always exist
   * This is effectively a no-op
   */
  async createDatabase(
    _container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const dbNum = parseInt(database, 10)
    if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
      throw new Error(
        `Invalid Redis database number: ${database}. Must be 0-15.`,
      )
    }
    // No-op - Redis databases always exist
    logDebug(
      `Redis database ${database} is available (databases 0-15 always exist)`,
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
        `Invalid Redis database number: ${database}. Must be 0-15.`,
      )
    }

    const redisCli = await this.getRedisCliPathForVersion(version)

    // SELECT the database and FLUSHDB
    const cmd = `"${redisCli}" -h 127.0.0.1 -p ${port} -n ${database} FLUSHDB`

    try {
      await execAsync(cmd, { timeout: 10000 })
      logDebug(`Flushed Redis database ${database}`)
    } catch (error) {
      const err = error as Error
      logDebug(`FLUSHDB failed: ${err.message}`)
      throw new Error(
        `Failed to flush Redis database ${database}: ${err.message}`,
      )
    }
  }

  /**
   * Get the memory usage of the Redis server in bytes
   *
   * NOTE: Redis does not provide per-database memory statistics.
   * This returns the total server memory (used_memory from INFO memory),
   * not the size of a specific numbered database (0-15).
   * This is acceptable for SpinDB since each container runs one Redis server.
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, version } = container

    try {
      const redisCli = await this.getRedisCliPathForVersion(version)
      // INFO memory returns server-wide stats (database selection has no effect)
      const cmd = `"${redisCli}" -h 127.0.0.1 -p ${port} INFO memory`

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
   * Dump from a remote Redis connection
   * Creates a text-format backup by scanning all keys from the remote server
   *
   * Connection string format: redis://[user:password@]host:port[/db]
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const redisCli = await getRedisCliPath()
    if (!redisCli) {
      throw new Error(REDIS_CLI_NOT_FOUND_ERROR)
    }

    // Parse connection string
    const { host, port, username, password, database, tls } =
      parseRedisConnectionString(connectionString)

    logDebug(
      `Connecting to remote Redis at ${host}:${port} (db: ${database}, tls: ${tls})`,
    )

    // Build CLI args for remote connection (password passed via env var for security)
    const buildArgs = (): string[] => {
      const args = ['-h', host, '-p', String(port)]
      // Redis 6.0+ ACL: pass username via --user flag
      if (username) {
        args.push('--user', username)
      }
      // Enable TLS for rediss:// scheme
      if (tls) {
        args.push('--tls')
      }
      // Note: password is passed via REDISCLI_AUTH env var, not command line
      args.push('-n', String(database))
      return args
    }

    // Execute a Redis command on the remote server with timeout
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
        const proc = spawn(redisCli, args, {
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
            reject(new Error(stderr || `redis-cli exited with code ${code}`))
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
        `Failed to connect to Redis at ${host}:${port}: ${(error as Error).message}`,
      )
    }

    // Build text backup from remote keys
    const commands: string[] = []
    commands.push('# Redis backup generated by SpinDB')
    commands.push(`# Source: ${host}:${port}`)
    commands.push(`# Date: ${new Date().toISOString()}`)
    commands.push('')

    // WARNING: KEYS * blocks the Redis server during execution.
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

    logDebug(`Found ${keys.length} keys on remote Redis`)

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
        // TODO: Add Redis Streams support (XRANGE/XADD commands)
        // Streams are a complex data type that would require special handling
        // for the message IDs and fields. Consider implementing if there's demand.
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
        keys.length === 0 ? ['Remote Redis database is empty'] : undefined,
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

  // Run a Redis command file or inline command
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port, version } = container
    const db = options.database || container.database || '0'

    const redisCli = await this.getRedisCliPathForVersion(version)

    if (options.file) {
      // Read file and pipe to redis-cli via stdin (avoids shell interpolation issues)
      const fileContent = await readFile(options.file, 'utf-8')
      const args = ['-h', '127.0.0.1', '-p', String(port), '-n', db]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(redisCli, args, {
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
            reject(new Error(`redis-cli exited with code ${code}`))
          }
        })

        // Write file content to stdin and close it
        proc.stdin?.write(fileContent)
        proc.stdin?.end()
      })
    } else if (options.sql) {
      // Run inline command by piping to redis-cli stdin (avoids shell quoting issues on Windows)
      const args = ['-h', '127.0.0.1', '-p', String(port), '-n', db]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(redisCli, args, {
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
            reject(new Error(`redis-cli exited with code ${code}`))
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

    const redisCli = await this.getRedisCliPathForVersion(version)

    return new Promise((resolve, reject) => {
      const args = ['-h', '127.0.0.1', '-p', String(port), '-n', db, '--raw']

      const proc = spawn(redisCli, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
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
          resolve(parseRedisResult(stdout, query))
        } else {
          reject(new Error(stderr || `redis-cli exited with code ${code}`))
        }
      })

      // Write command to stdin and close it
      proc.stdin?.write(query + '\n')
      proc.stdin?.end()
    })
  }

  /**
   * List databases for Redis.
   * Redis uses numbered databases (0-15 by default), not named databases.
   * Returns the configured database number as a single-item array.
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    // Redis has numbered databases, not named ones
    // Return the container's configured database
    return [container.database]
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password } = options
    assertValidUsername(username)
    const { port } = container
    const redisCli = await this.getRedisCliPath(container.version)

    // Reject passwords with characters that break ACL SETUSER syntax:
    // '>' sets password, '#' sets hash, '<' removes password — all are ACL delimiters.
    // Whitespace and newlines would split the command unexpectedly.
    if (/[>#<\s\n\r]/.test(password)) {
      throw new Error(
        'Password contains invalid characters for Redis ACL. Passwords must not contain ">", "#", "<", whitespace, or newlines.',
      )
    }

    // ACL SETUSER is idempotent - sets user with full access
    const cmd = buildRedisCliCommand(
      redisCli,
      port,
      `ACL SETUSER ${username} on >${password} ~* &* +@all`,
    )

    await execAsync(cmd, { timeout: 10000 })
    logDebug(`Created Redis user: ${username}`)

    const db = container.database ?? '0'
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

export const redisEngine = new RedisEngine()
