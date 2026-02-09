import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink, chmod } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  logDebug,
  logWarning,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { clickhouseBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  CLICKHOUSE_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  validateClickHouseIdentifier,
  escapeClickHouseIdentifier,
} from './cli-utils'
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
import { parseClickHouseJSONResult } from '../../core/query-parser'

const ENGINE = 'clickhouse'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Generate ClickHouse server configuration XML
 */
function generateClickHouseConfig(options: {
  port: number
  httpPort: number
  dataDir: string
  logDir: string
  tmpDir: string
  pidFile: string
}): string {
  const { port, httpPort, dataDir, logDir, tmpDir, pidFile } = options

  return `<?xml version="1.0"?>
<clickhouse>
    <logger>
        <level>information</level>
        <log>${logDir}/clickhouse-server.log</log>
        <errorlog>${logDir}/clickhouse-server.err.log</errorlog>
        <size>100M</size>
        <count>3</count>
    </logger>

    <http_port>${httpPort}</http_port>
    <tcp_port>${port}</tcp_port>

    <listen_host>127.0.0.1</listen_host>

    <pid_file>${pidFile}</pid_file>

    <path>${dataDir}/</path>
    <tmp_path>${tmpDir}/</tmp_path>
    <user_files_path>${dataDir}/user_files/</user_files_path>

    <users_config>users.xml</users_config>

    <default_profile>default</default_profile>
    <default_database>default</default_database>

    <mark_cache_size>5368709120</mark_cache_size>
    <max_concurrent_queries>100</max_concurrent_queries>

    <user_directories>
        <users_xml>
            <path>users.xml</path>
        </users_xml>
        <local_directory>
            <path>${dataDir}/access/</path>
        </local_directory>
    </user_directories>
</clickhouse>
`
}

/**
 * Generate ClickHouse users configuration XML
 */
function generateUsersConfig(): string {
  return `<?xml version="1.0"?>
<clickhouse>
    <profiles>
        <default>
            <max_memory_usage>10000000000</max_memory_usage>
            <use_uncompressed_cache>0</use_uncompressed_cache>
            <load_balancing>random</load_balancing>
        </default>
    </profiles>

    <users>
        <default>
            <password></password>
            <networks>
                <ip>127.0.0.1</ip>
            </networks>
            <profile>default</profile>
            <quota>default</quota>
            <access_management>1</access_management>
        </default>
    </users>

    <quotas>
        <default>
            <interval>
                <duration>3600</duration>
                <queries>0</queries>
                <errors>0</errors>
                <result_rows>0</result_rows>
                <read_rows>0</read_rows>
                <execution_time>0</execution_time>
            </interval>
        </default>
    </quotas>
</clickhouse>
`
}

/**
 * Parse a ClickHouse connection string
 * Format: clickhouse://[user:password@]host[:port][/database]
 *
 * Examples:
 * - clickhouse://localhost:8123
 * - clickhouse://default:password@localhost:8123/mydb
 * - clickhouse://user:pass@remote.host:8123/analytics
 */
function parseClickHouseConnectionString(connectionString: string): {
  baseUrl: string
  user: string | undefined
  password: string | undefined
  database: string
} {
  let url: URL

  // Normalize connection string
  let normalized = connectionString.trim()

  // Support clickhouse:// scheme (convert to http:// for URL parsing)
  if (normalized.startsWith('clickhouse://')) {
    normalized = normalized.replace('clickhouse://', 'http://')
  } else if (
    !normalized.startsWith('http://') &&
    !normalized.startsWith('https://')
  ) {
    throw new Error(
      `Invalid ClickHouse connection string: ${connectionString}\n` +
        'Expected format: clickhouse://[user:password@]host:port[/database]',
    )
  }

  try {
    url = new URL(normalized)
  } catch {
    throw new Error(
      `Invalid ClickHouse connection string: ${connectionString}\n` +
        'Expected format: clickhouse://[user:password@]host:port[/database]',
    )
  }

  const host = url.hostname || 'localhost'
  // ClickHouse HTTP API default port is 8123
  const port = parseInt(url.port, 10) || 8123
  const scheme = url.protocol === 'https:' ? 'https' : 'http'

  const user = url.username || undefined
  const password = url.password || undefined

  // Database is in the path
  let database = 'default'
  if (url.pathname && url.pathname !== '/') {
    database = url.pathname.replace(/^\//, '')
  }

  const baseUrl = `${scheme}://${host}:${port}`

  return { baseUrl, user, password, database }
}

export class ClickHouseEngine extends BaseEngine {
  name = ENGINE
  displayName = 'ClickHouse'
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

  // Resolves version string to full version (e.g., '25.12' -> '25.12.3.21')
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return CLICKHOUSE_VERSION_MAP[version] || version
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'clickhouse',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that ClickHouse binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const clickhousePath = join(binPath, 'bin', 'clickhouse')
    return existsSync(clickhousePath)
  }

  // Check if a specific ClickHouse version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return clickhouseBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure ClickHouse binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await clickhouseBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binary in config
    const clickhousePath = join(binPath, 'bin', 'clickhouse')
    if (existsSync(clickhousePath)) {
      await configManager.setBinaryPath('clickhouse', clickhousePath, 'bundled')
    }

    return binPath
  }

  /**
   * Initialize a new ClickHouse data directory
   * Creates the directory structure and configuration files
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
    const logDir = containerDir
    const tmpDir = join(dataDir, 'tmp')
    const port = (options.port as number) || engineDef.defaultPort
    const httpPort = port + 1 // HTTP port is native port + 1

    // Create directories
    await mkdir(dataDir, { recursive: true })
    await mkdir(tmpDir, { recursive: true })
    await mkdir(join(dataDir, 'user_files'), { recursive: true })
    await mkdir(join(dataDir, 'access'), { recursive: true })

    logDebug(`Created ClickHouse data directory: ${dataDir}`)

    // Generate config.xml
    const configPath = join(containerDir, 'config.xml')
    const pidFile = join(containerDir, engineDef.pidFileName)
    const configContent = generateClickHouseConfig({
      port,
      httpPort,
      dataDir,
      logDir,
      tmpDir,
      pidFile,
    })
    await writeFile(configPath, configContent)
    logDebug(`Generated ClickHouse config: ${configPath}`)

    // Generate users.xml
    const usersConfigPath = join(containerDir, 'users.xml')
    const usersConfigContent = generateUsersConfig()
    await writeFile(usersConfigPath, usersConfigContent)
    logDebug(`Generated ClickHouse users config: ${usersConfigPath}`)

    return dataDir
  }

  /**
   * Regenerate config.xml with updated paths after container rename
   * Called by container-manager after moving the directory
   */
  async regenerateConfig(containerName: string, port: number): Promise<void> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })
    const logDir = containerDir
    const tmpDir = join(dataDir, 'tmp')
    const httpPort = port + 1

    const accessDir = join(dataDir, 'access')
    try {
      await mkdir(accessDir, { recursive: true, mode: 0o700 })
      await chmod(accessDir, 0o700).catch((err) => {
        logDebug(`Failed to chmod ${accessDir}: ${err}`)
      })
    } catch (error) {
      logWarning(
        `Failed to create ClickHouse access directory ${accessDir}: ${error}`,
      )
    }

    const configPath = join(containerDir, 'config.xml')
    const pidFile = join(containerDir, engineDef.pidFileName)
    const configContent = generateClickHouseConfig({
      port,
      httpPort,
      dataDir,
      logDir,
      tmpDir,
      pidFile,
    })
    await writeFile(configPath, configContent)
    logDebug(`Regenerated ClickHouse config after rename: ${configPath}`)
  }

  // Get the path to clickhouse binary for a version
  async getClickHousePath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'clickhouse',
      version: fullVersion,
      platform,
      arch,
    })
    const clickhousePath = join(binPath, 'bin', 'clickhouse')
    if (existsSync(clickhousePath)) {
      return clickhousePath
    }
    throw new Error(
      `ClickHouse ${version} is not installed. Run: spindb engines download clickhouse ${version}`,
    )
  }

  // Get the path to clickhouse binary (for client operations)
  override async getClickHouseClientPath(version?: string): Promise<string> {
    // Check config cache first
    const cached = await configManager.getBinaryPath('clickhouse')
    if (cached && existsSync(cached)) {
      return cached
    }

    // If version provided, use downloaded binary
    if (version) {
      return this.getClickHousePath(version)
    }

    throw new Error(
      'ClickHouse binary not found. Run: spindb engines download clickhouse <version>',
    )
  }

  /**
   * Start ClickHouse server
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version, binaryPath } = container

    // Check if already running
    const alreadyRunning = await processManager.isRunning(name, {
      engine: ENGINE,
    })
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // Get ClickHouse binary path
    let clickhouseBinary: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(binaryPath, 'bin', 'clickhouse')
      if (existsSync(serverPath)) {
        clickhouseBinary = serverPath
        logDebug(`Using stored binary path: ${clickhouseBinary}`)
      }
    }

    if (!clickhouseBinary) {
      try {
        clickhouseBinary = await this.getClickHousePath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `ClickHouse ${version} is not installed. Run: spindb engines download clickhouse ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'config.xml')
    const logFile = join(containerDir, 'clickhouse-server.log')
    const pidFile = join(containerDir, 'clickhouse.pid')

    onProgress?.({ stage: 'starting', message: 'Starting ClickHouse...' })

    logDebug(`Starting ClickHouse with config: ${configPath}`)

    const args = ['server', '--config-file', configPath, '--daemon']

    // Spawn the daemon process and wait for it to exit
    // ClickHouse with --daemon forks immediately and the parent exits
    const spawnResult = await new Promise<{
      code: number | null
      stdout: string
      stderr: string
    }>((resolve, reject) => {
      const proc = spawn(clickhouseBinary!, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        logDebug(`clickhouse stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        logDebug(`clickhouse stderr: ${data.toString()}`)
      })

      proc.on('error', reject)

      proc.on('close', (code) => {
        logDebug(`ClickHouse spawn process closed with code: ${code}`)
        // Don't unref until we capture the result
        proc.unref()
        resolve({ code, stdout, stderr })
      })
    })

    // Check if spawn was successful
    if (spawnResult.code !== 0 && spawnResult.code !== null) {
      throw new Error(
        spawnResult.stderr ||
          spawnResult.stdout ||
          `clickhouse server exited with code ${spawnResult.code}`,
      )
    }

    // Wait for server to be ready (outside of event handler to keep event loop alive)
    logDebug(`Waiting for ClickHouse server to be ready on port ${port}...`)
    const ready = await this.waitForReady(port, version)
    logDebug(`waitForReady returned: ${ready}`)

    if (!ready) {
      throw new Error(
        `ClickHouse failed to start within timeout. Check logs at: ${logFile}`,
      )
    }

    // ClickHouse in daemon mode doesn't respect <pid_file> config
    // So we manually find and write the PID after server is ready
    logDebug(`Finding PID for port ${port}...`)
    try {
      const pids = await platformService.findProcessByPort(port)
      logDebug(`findProcessByPort output: ${JSON.stringify(pids)}`)
      if (pids.length > 0) {
        const serverPid = String(pids[0])
        logDebug(`Writing PID ${serverPid} to ${pidFile}`)
        await writeFile(pidFile, serverPid, 'utf8')
        logDebug(`Wrote PID ${serverPid} to ${pidFile}`)
      } else {
        logDebug(`No PIDs found for port ${port}`)
      }
    } catch (pidError) {
      // Non-fatal: PID file is optional for operation
      logDebug(`Could not write PID file: ${pidError}`)
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // Wait for ClickHouse to be ready
  // ClickHouse can take longer to start on CI runners due to resource constraints
  private async waitForReady(
    port: number,
    version: string,
    timeoutMs = 120000,
  ): Promise<boolean> {
    logDebug(`waitForReady called for port ${port}, version ${version}`)
    const startTime = Date.now()
    const checkInterval = 500

    let clickhouse: string
    try {
      logDebug('Getting clickhouse client path...')
      clickhouse = await this.getClickHouseClientPath(version)
      logDebug(`Got clickhouse client path: ${clickhouse}`)
    } catch (err) {
      logDebug(`Error getting clickhouse client path: ${err}`)
      logWarning(
        'ClickHouse binary not found, cannot verify server is ready. Assuming ready after delay.',
      )
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return true
    }

    logDebug(`Starting connection loop, timeout: ${timeoutMs}ms`)
    let attempt = 0
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      logDebug(`Connection attempt ${attempt}...`)
      try {
        const args = [
          'client',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--query',
          'SELECT 1',
        ]
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(clickhouse, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          proc.on('close', (code) => {
            logDebug(`Client process closed with code ${code}`)
            if (code === 0) resolve()
            else reject(new Error(`Exit code ${code}`))
          })
          proc.on('error', (err) => {
            logDebug(`Client process error: ${err}`)
            reject(err)
          })
        })
        logDebug(`ClickHouse ready on port ${port}`)
        return true
      } catch (err) {
        logDebug(`Attempt ${attempt} failed: ${err}`)
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`ClickHouse did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop ClickHouse server
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'clickhouse.pid')

    logDebug(`Stopping ClickHouse container "${name}" on port ${port}`)

    // Find PID by checking the process using cross-platform helper
    let pid: number | null = null

    // Try to find ClickHouse process by port
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        pid = pids[0]
      }
    } catch {
      // Ignore
    }

    // Kill process if found
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing ClickHouse process ${pid}`)
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

    logDebug('ClickHouse stopped')
  }

  // Get ClickHouse server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { port, version } = container

    // Try to connect
    try {
      const clickhouse = await this.getClickHouseClientPath(version)
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--query',
        'SELECT 1',
      ]
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(clickhouse, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Exit code ${code}`))
        })
        proc.on('error', reject)
      })
      return { running: true, message: 'ClickHouse is running' }
    } catch {
      return { running: false, message: 'ClickHouse is not running' }
    }
  }

  // Detect backup format
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: { database?: string; clean?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name, port, version } = container

    return restoreBackup(backupPath, {
      containerName: name,
      port,
      database: options.database || container.database || 'default',
      version,
      clean: options.clean,
    })
  }

  /**
   * Get connection string
   * Format: clickhouse://127.0.0.1:PORT/DATABASE
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'default'
    return `clickhouse://127.0.0.1:${port}/${db}`
  }

  // Open clickhouse client interactive shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port, version } = container
    const db = database || container.database || 'default'

    const clickhouse = await this.getClickHouseClientPath(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        clickhouse,
        [
          'client',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--database',
          db,
        ],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * Create a new database
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port, version } = container

    // Validate database identifier to prevent SQL injection
    validateClickHouseIdentifier(database, 'database')
    const escapedDb = escapeClickHouseIdentifier(database)

    const clickhouse = await this.getClickHouseClientPath(version)

    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--query',
      `CREATE DATABASE IF NOT EXISTS ${escapedDb}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(clickhouse, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Created ClickHouse database: ${database}`)
          resolve()
        } else {
          reject(new Error(`Failed to create database: ${stderr}`))
        }
      })
      proc.on('error', reject)
    })
  }

  /**
   * Drop a database
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port, version } = container

    if (database === 'default' || database === 'system') {
      throw new Error(`Cannot drop system database: ${database}`)
    }

    // Validate database identifier to prevent SQL injection
    validateClickHouseIdentifier(database, 'database')
    const escapedDb = escapeClickHouseIdentifier(database)

    const clickhouse = await this.getClickHouseClientPath(version)

    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--query',
      `DROP DATABASE IF EXISTS ${escapedDb}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(clickhouse, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Dropped ClickHouse database: ${database}`)
          resolve()
        } else {
          reject(new Error(`Failed to drop database: ${stderr}`))
        }
      })
      proc.on('error', reject)
    })
  }

  /**
   * Get the database size in bytes
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, version, database } = container

    try {
      const clickhouse = await this.getClickHouseClientPath(version)
      // Validate and escape the database name to prevent SQL injection
      const dbName = database || 'default'
      validateClickHouseIdentifier(dbName, 'database')
      // Escape single quotes for string literal in WHERE clause
      const escapedDbName = dbName.replace(/'/g, "''")
      const query = `SELECT sum(bytes_on_disk) FROM system.parts WHERE database = '${escapedDbName}'`

      const result = await new Promise<string>((resolve, reject) => {
        const args = [
          'client',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--query',
          query,
        ]

        const proc = spawn(clickhouse, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        proc.on('close', (code) => {
          if (code === 0) resolve(stdout.trim())
          else reject(new Error(`Exit code ${code}`))
        })
        proc.on('error', reject)
      })

      const size = parseInt(result, 10)
      return isNaN(size) ? null : size
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote ClickHouse connection
   * Uses ClickHouse's HTTP API to export schema and data
   *
   * Connection string format: clickhouse://[user:password@]host[:port][/database]
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // Parse connection string
    const { baseUrl, user, password, database } =
      parseClickHouseConnectionString(connectionString)

    // Validate and escape database identifier for SQL injection prevention
    validateClickHouseIdentifier(database, 'database')
    const escapedDatabase = escapeClickHouseIdentifier(database)

    logDebug(`Connecting to remote ClickHouse at ${baseUrl} (db: ${database})`)

    // Build headers for authentication
    const headers: Record<string, string> = {}
    if (user) {
      headers['X-ClickHouse-User'] = user
      if (password) {
        headers['X-ClickHouse-Key'] = password
      }
    }

    // Helper to execute a query via HTTP API
    const execQuery = async (query: string): Promise<string> => {
      const url = new URL(baseUrl)
      url.searchParams.set('query', query)
      url.searchParams.set('database', database)

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`ClickHouse query failed: ${errorText}`)
      }

      return response.text()
    }

    // Test connectivity
    try {
      const result = await execQuery('SELECT 1')
      if (!result.trim().includes('1')) {
        throw new Error(`Unexpected test query response: ${result.trim()}`)
      }
    } catch (error) {
      throw new Error(
        `Failed to connect to ClickHouse at ${baseUrl}: ${(error as Error).message}`,
      )
    }

    // Get list of tables
    const tablesResult = await execQuery(
      `SELECT name FROM system.tables WHERE database = '${database.replace(/'/g, "''")}' ORDER BY name`,
    )
    const tables = tablesResult
      .trim()
      .split('\n')
      .filter((t) => t.trim())

    logDebug(`Found ${tables.length} tables in database ${database}`)

    // Build SQL backup
    const lines: string[] = []
    lines.push('-- ClickHouse backup generated by SpinDB')
    lines.push(`-- Source: ${baseUrl}`)
    lines.push(`-- Database: ${database}`)
    lines.push(`-- Date: ${new Date().toISOString()}`)
    lines.push('')

    for (const table of tables) {
      // Validate table name
      validateClickHouseIdentifier(table, 'table')
      const escapedTable = escapeClickHouseIdentifier(table)

      lines.push(`-- Table: ${table}`)
      lines.push('')

      // Get CREATE TABLE statement (using TSVRaw for unescaped output)
      try {
        const createUrl = new URL(baseUrl)
        createUrl.searchParams.set(
          'query',
          `SHOW CREATE TABLE ${escapedDatabase}.${escapedTable} FORMAT TSVRaw`,
        )

        const createResponse = await fetch(createUrl.toString(), { headers })
        if (!createResponse.ok) {
          logWarning(`Could not get CREATE TABLE for ${table}`)
          continue
        }

        let createStmt = (await createResponse.text()).trim()

        // Strip database prefix for portability
        const dbPrefixPattern = new RegExp(
          `(CREATE TABLE\\s+)\`?${database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?\\.`,
          'i',
        )
        createStmt = createStmt.replace(dbPrefixPattern, '$1')

        lines.push(createStmt + ';')
        lines.push('')
      } catch (error) {
        logWarning(`Could not get CREATE TABLE for ${table}: ${error}`)
        continue
      }

      // Export data using SQLInsert format
      try {
        const dataUrl = new URL(baseUrl)
        dataUrl.searchParams.set(
          'query',
          `SELECT * FROM ${escapedDatabase}.${escapedTable} FORMAT SQLInsert`,
        )

        const dataResponse = await fetch(dataUrl.toString(), { headers })
        if (!dataResponse.ok) {
          const errorText = await dataResponse.text()
          logWarning(
            `Could not export data for ${table}: HTTP ${dataResponse.status} - ${errorText}`,
          )
        } else {
          const data = (await dataResponse.text()).trim()
          if (data) {
            // SQLInsert format uses 'table' as placeholder, replace with actual table name
            // Handle variations: TABLE, `table`, "table", 'table' with optional whitespace
            const insertData = data.replace(
              /INSERT\s+INTO\s+[`"']?table[`"']?\s*\(/gi,
              `INSERT INTO ${escapedTable} (`,
            )
            lines.push(insertData)
            lines.push('')
          }
        }
      } catch (error) {
        logWarning(`Could not export data for ${table}: ${error}`)
      }
    }

    // Write to file
    const content = lines.join('\n')
    await writeFile(outputPath, content, 'utf-8')

    return {
      filePath: outputPath,
      warnings:
        tables.length === 0
          ? [`Database '${database}' has no tables`]
          : undefined,
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

  // Run a SQL file or inline SQL statement
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port, version } = container
    const db = options.database || container.database || 'default'

    const clickhouse = await this.getClickHouseClientPath(version)

    if (options.file) {
      // Read file and pipe to clickhouse client
      const fileContent = await readFile(options.file, 'utf-8')
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--database',
        db,
        '--multiquery',
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(clickhouse, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0 || code === null) resolve()
          else reject(new Error(`clickhouse client exited with code ${code}`))
        })

        proc.stdin?.write(fileContent)
        proc.stdin?.end()
      })
    } else if (options.sql) {
      // Run inline SQL via stdin to avoid command injection
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--database',
        db,
        '--multiquery',
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(clickhouse, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0 || code === null) resolve()
          else reject(new Error(`clickhouse client exited with code ${code}`))
        })

        proc.stdin?.write(options.sql)
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
    const db = options?.database || container.database || 'default'

    const clickhouse = await this.getClickHouseClientPath(version)

    // Handle FORMAT clause: replace existing FORMAT or append FORMAT JSON
    // Regex matches "FORMAT <type>" with optional trailing whitespace/semicolon
    let queryWithFormat = query.trim()
    const formatRegex = /\bFORMAT\s+\w+\s*;?\s*$/i
    if (formatRegex.test(queryWithFormat)) {
      // Replace existing FORMAT clause with FORMAT JSON
      queryWithFormat = queryWithFormat.replace(formatRegex, 'FORMAT JSON')
    } else {
      // No FORMAT clause, append FORMAT JSON
      queryWithFormat = queryWithFormat.replace(/;?\s*$/, ' FORMAT JSON')
    }

    return new Promise((resolve, reject) => {
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--database',
        db,
        '--query',
        queryWithFormat,
      ]

      const proc = spawn(clickhouse, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
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
        if (code === 0) {
          resolve(parseClickHouseJSONResult(stdout))
        } else {
          reject(new Error(stderr || `clickhouse exited with code ${code}`))
        }
      })
    })
  }

  /**
   * List all user databases, excluding system databases (system, information_schema, INFORMATION_SCHEMA).
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { port, version } = container
    const clickhouse = await this.getClickHouseClientPath(version)

    logDebug(`Listing databases on port ${port} with version ${version}`)

    return new Promise((resolve, reject) => {
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--query',
        'SHOW DATABASES',
      ]

      const proc = spawn(clickhouse, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
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
        if (code !== 0) {
          reject(new Error(stderr || `clickhouse exited with code ${code}`))
          return
        }

        // Parse output (one database per line)
        const systemDatabases = [
          'system',
          'information_schema',
          'INFORMATION_SCHEMA',
        ]
        const databases = stdout
          .trim()
          .split('\n')
          .map((db) => db.trim())
          .filter((db) => db.length > 0 && !systemDatabases.includes(db))

        resolve(databases)
      })
    })
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password, database } = options
    assertValidUsername(username)
    const { port, version } = container
    const db = database || container.database || 'default'

    validateClickHouseIdentifier(username, 'username')
    validateClickHouseIdentifier(db, 'database')
    const escapedUser = escapeClickHouseIdentifier(username)
    const escapedDb = escapeClickHouseIdentifier(db)

    const clickhouse = await this.getClickHouseClientPath(version)

    const escapedPass = password.replace(/\\/g, '\\\\').replace(/'/g, "''")
    const sql = `CREATE USER IF NOT EXISTS ${escapedUser} IDENTIFIED BY '${escapedPass}'; ALTER USER ${escapedUser} IDENTIFIED BY '${escapedPass}'; GRANT ALL ON ${escapedDb}.* TO ${escapedUser};`

    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--multiquery',
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(clickhouse, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Created ClickHouse user: ${username}`)
          resolve()
        } else {
          reject(new Error(`Failed to create user: ${stderr}`))
        }
      })
      proc.on('error', reject)

      proc.stdin?.write(sql)
      proc.stdin?.end()
    })

    const connectionString = `clickhouse://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`

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

export const clickhouseEngine = new ClickHouseEngine()
