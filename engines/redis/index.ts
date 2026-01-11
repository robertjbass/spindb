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
import { redisBinaryManager } from './binary-manager'
import {
  getBinaryUrl,
  SUPPORTED_MAJOR_VERSIONS,
  FALLBACK_VERSION_MAP,
} from './binary-urls'
import { normalizeVersion } from './version-maps'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import type {
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  BackupOptions,
  BackupResult,
  RestoreResult,
  DumpResult,
  StatusResult,
} from '../../types'

const execAsync = promisify(exec)

const ENGINE = 'redis'
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

/**
 * Validate that a command doesn't contain shell injection patterns
 */
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
 * Build a redis-cli command for inline command execution
 */
export function buildRedisCliCommand(
  redisCliPath: string,
  port: number,
  command: string,
  options?: { database?: string },
): string {
  // Validate command doesn't contain shell injection patterns
  validateCommand(command)

  const db = options?.database || '0'
  if (isWindows()) {
    // Windows: use double quotes
    const escaped = command.replace(/"/g, '\\"')
    return `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${db} ${escaped}`
  } else {
    // Unix: pass command directly (Redis commands are simple)
    return `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${db} ${command}`
  }
}

/**
 * Generate Redis configuration file content
 */
function generateRedisConfig(options: {
  port: number
  dataDir: string
  logFile: string
  pidFile: string
  daemonize?: boolean
}): string {
  // Windows Redis doesn't support daemonize natively, use detached spawn instead
  const daemonizeValue = options.daemonize ?? true

  return `# SpinDB generated Redis configuration
port ${options.port}
bind 127.0.0.1
dir ${options.dataDir}
daemonize ${daemonizeValue ? 'yes' : 'no'}
logfile ${options.logFile}
pidfile ${options.pidFile}

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

  /**
   * Get platform info for binary operations
   */
  getPlatformInfo(): { platform: string; arch: string } {
    return platformService.getPlatformInfo()
  }

  /**
   * Fetch available versions from hostdb
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    const versions: Record<string, string[]> = {}

    for (const major of SUPPORTED_MAJOR_VERSIONS) {
      versions[major] = [FALLBACK_VERSION_MAP[major]]
    }

    return versions
  }

  /**
   * Get binary download URL from hostdb
   */
  getBinaryUrl(version: string, platform: string, arch: string): string {
    return getBinaryUrl(version, platform, arch)
  }

  /**
   * Verify that Redis binaries are available
   */
  async verifyBinary(binPath: string): Promise<boolean> {
    const serverPath = join(binPath, 'bin', 'redis-server')
    return existsSync(serverPath)
  }

  /**
   * Check if a specific Redis version is installed (downloaded)
   */
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
    const serverTools = ['redis-server'] as const
    const clientTools = ['redis-cli'] as const

    for (const tool of serverTools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    for (const tool of clientTools) {
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

  /**
   * Get the path to redis-server for a version
   */
  async getRedisServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform,
      arch,
    })
    const serverPath = join(binPath, 'bin', 'redis-server')
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Redis ${version} is not installed. Run: spindb engines download redis ${version}`,
    )
  }

  /**
   * Get the path to redis-cli for a version
   */
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
      const cliPath = join(binPath, 'bin', 'redis-cli')
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
      } catch {
        // Binary not downloaded yet - this is an orphaned container situation
        throw new Error(
          `Redis ${version} is not installed. Run: spindb engines download redis ${version}`,
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
      // Windows: spawn detached process (no daemonize support)
      const spawnOpts: SpawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      }

      const proc = spawn(redisServer, [configPath], spawnOpts)

      proc.stdout?.on('data', (data: Buffer) => {
        logDebug(`redis-server stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        logDebug(`redis-server stderr: ${data.toString()}`)
      })

      // Detach the process so it continues running after parent exits
      proc.unref()

      // Wait for Redis to be ready
      const ready = await this.waitForReady(port, version)
      if (ready) {
        return {
          port,
          connectionString: this.getConnectionString(container),
        }
      } else {
        // Check log for errors
        const portError = await checkLogForPortError()
        if (portError) {
          throw new Error(portError)
        }
        throw new Error(
          `Redis failed to start within timeout. Check logs at: ${logFile}`,
        )
      }
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

  /**
   * Wait for Redis to be ready to accept connections
   */
  private async waitForReady(
    port: number,
    version: string,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    const redisCli = await this.getRedisCliPathForVersion(version)
    if (!redisCli) {
      logWarning('redis-cli not found, cannot verify Redis is ready')
      return true
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

  /**
   * Get Redis server status
   */
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

  /**
   * Detect backup format
   */
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

  /**
   * Open redis-cli interactive shell
   */
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

  /**
   * Get path to iredis (enhanced CLI) if installed
   */
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

  /**
   * Connect with iredis (enhanced CLI)
   */
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
   * Redis doesn't support remote dump like pg_dump/mongodump
   * Throw an error with guidance
   */
  async dumpFromConnectionString(
    _connectionString: string,
    _outputPath: string,
  ): Promise<DumpResult> {
    throw new Error(
      'Redis does not support creating containers from remote connection strings.\n' +
        'To migrate data from a remote Redis instance:\n' +
        '  1. On remote server: redis-cli --rdb dump.rdb\n' +
        '  2. Copy dump.rdb to local machine\n' +
        '  3. spindb restore <container> dump.rdb',
    )
  }

  /**
   * Create a backup
   */
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  /**
   * Run a Redis command file or inline command
   */
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
}

export const redisEngine = new RedisEngine()
