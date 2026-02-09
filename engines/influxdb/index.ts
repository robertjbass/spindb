import { spawn, type SpawnOptions } from 'child_process'
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
import { portManager } from '../../core/port-manager'
import { influxdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { influxdbApiRequest } from './api-client'
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
} from '../../types'
import { parseRESTAPIResult } from '../../core/query-parser'

const ENGINE = 'influxdb'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Initial delay before checking if InfluxDB is ready after spawning.
 * Windows requires a longer delay as process startup is slower.
 */
const START_CHECK_DELAY_MS = isWindows() ? 2000 : 500

/**
 * Parse an InfluxDB connection string
 * Supported formats:
 * - http://host:port
 * - https://host:port
 * - influxdb://host:port (converted to http)
 */
function parseInfluxDBConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
  database?: string
} {
  let url: URL
  let scheme = 'http'

  // Handle influxdb:// scheme by converting to http://
  let normalized = connectionString.trim()
  if (normalized.startsWith('influxdb://')) {
    normalized = normalized.replace('influxdb://', 'http://')
  }

  // Ensure scheme is present
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `http://${normalized}`
  }

  try {
    url = new URL(normalized)
    scheme = url.protocol.replace(':', '')
  } catch {
    throw new Error(
      `Invalid InfluxDB connection string: ${connectionString}\n` +
        'Expected format: http://host:port or influxdb://host:port',
    )
  }

  // Extract token if provided
  const token = url.searchParams.get('token')
  const database = url.searchParams.get('db') || undefined

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  // Construct base URL without query params
  const port = url.port || '8086'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  return { baseUrl, headers, database }
}

/**
 * Make an HTTP request to a remote InfluxDB server
 */
async function remoteInfluxDBRequest(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<{ status: number; data: unknown }> {
  const url = `${baseUrl}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  try {
    const response = await fetch(url, options)

    let data: unknown
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      data = await response.json()
    } else {
      data = await response.text()
    }

    return { status: response.status, data }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `Remote InfluxDB request timed out after ${timeoutMs / 1000}s: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export class InfluxDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'InfluxDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // Get platform info for binary operations
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  // Fetch available versions from hostdb
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  // Get binary download URL from hostdb
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // Resolves version string to full version (e.g., '3' -> '3.8.0')
  resolveFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'influxdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that InfluxDB binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `influxdb3${ext}`)
    return existsSync(serverPath)
  }

  // Check if a specific InfluxDB version is installed
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return influxdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure InfluxDB binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await influxdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binaries in config
    const ext = platformService.getExecutableExtension()
    const tools = ['influxdb3'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * Initialize a new InfluxDB data directory
   */
  async initDataDir(
    containerName: string,
    _version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })

    // Create container directory if it doesn't exist
    if (!existsSync(containerDir)) {
      await mkdir(containerDir, { recursive: true })
    }

    // Create data directory if it doesn't exist
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created InfluxDB data directory: ${dataDir}`)
    }

    return dataDir
  }

  // Get the path to influxdb3 server for a version
  async getInfluxDBServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'influxdb',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `influxdb3${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `InfluxDB ${version} is not installed. Run: spindb engines download influxdb ${version}`,
    )
  }

  // Get the path to influxdb3 binary
  async getInfluxDBPath(version?: string): Promise<string> {
    // Check config cache first
    const cached = await configManager.getBinaryPath('influxdb3')
    if (cached && existsSync(cached)) {
      return cached
    }

    // If version provided, use downloaded binary
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'influxdb',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const influxdbPath = join(binPath, 'bin', `influxdb3${ext}`)
      if (existsSync(influxdbPath)) {
        return influxdbPath
      }
    }

    throw new Error(
      'influxdb3 not found. Run: spindb engines download influxdb <version>',
    )
  }

  /**
   * Start InfluxDB server
   * CLI: influxdb3 serve --data-dir /path/to/data --http-bind 127.0.0.1:PORT
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

    // Use stored binary path if available
    let influxdbServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `influxdb3${ext}`)
      if (existsSync(serverPath)) {
        influxdbServer = serverPath
        logDebug(`Using stored binary path: ${influxdbServer}`)
      }
    }

    // Fall back to normal path
    if (!influxdbServer) {
      try {
        influxdbServer = await this.getInfluxDBServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `InfluxDB ${version} is not installed. Run: spindb engines download influxdb ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    logDebug(`Using influxdb3 for version ${version}: ${influxdbServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'influxdb.pid')

    // On Windows, wait longer for ports to be released
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckStart = Date.now()
    const portCheckInterval = 1000

    // Check if HTTP port is available
    while (!(await portManager.isPortAvailable(port))) {
      if (Date.now() - portCheckStart >= portWaitTimeout) {
        throw new Error(`HTTP port ${port} is already in use.`)
      }
      logDebug(`Waiting for HTTP port ${port} to become available...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    onProgress?.({ stage: 'starting', message: 'Starting InfluxDB...' })

    // Build command arguments
    // InfluxDB 3.x uses 'serve' subcommand with required --node-id
    // Use fixed node-id so data persists across container renames
    const args = [
      'serve',
      '--node-id',
      'spindb',
      '--object-store',
      'file',
      '--data-dir',
      dataDir,
      '--http-bind',
      `127.0.0.1:${port}`,
      '--without-auth',
    ]

    logDebug(`Starting influxdb3 with args: ${args.join(' ')}`)

    /**
     * Check log file for startup errors
     */
    const checkLogForError = async (): Promise<string | null> => {
      try {
        const logContent = await readFile(logFile, 'utf-8')
        const recentLog = logContent.slice(-2000) // Last 2KB

        if (
          recentLog.includes('Address already in use') ||
          recentLog.includes('bind: Address already in use')
        ) {
          return `Port ${port} is already in use`
        }
        if (recentLog.includes('Failed to bind')) {
          return `Port ${port} is already in use`
        }
      } catch {
        // Log file might not exist yet
      }
      return null
    }

    // InfluxDB runs in foreground, so we need to spawn detached
    if (isWindows()) {
      return new Promise((resolve, reject) => {
        const spawnOpts: SpawnOptions = {
          cwd: containerDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
        }

        const proc = spawn(influxdbServer, args, spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`Failed to spawn InfluxDB server: ${err.message}`))
        })

        proc.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          const reason = signal ? `signal ${signal}` : `code ${code}`
          reject(
            new Error(
              `InfluxDB process exited unexpectedly (${reason}).\n` +
                `Stderr: ${stderrOutput || '(none)'}\n` +
                `Stdout: ${stdoutOutput || '(none)'}`,
            ),
          )
        })

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          stdoutOutput += str
          logDebug(`influxdb3 stdout: ${str}`)
        })
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          stderrOutput += str
          logDebug(`influxdb3 stderr: ${str}`)
        })

        proc.unref()

        setTimeout(async () => {
          if (settled) return

          if (!proc.pid) {
            settled = true
            reject(
              new Error('InfluxDB server process failed to start (no PID)'),
            )
            return
          }

          try {
            await writeFile(pidFile, String(proc.pid))
          } catch {
            // Non-fatal
          }

          const ready = await this.waitForReady(port)
          if (settled) return

          if (ready) {
            settled = true
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } else {
            settled = true

            // Clean up the orphaned detached process before rejecting
            if (proc.pid && platformService.isProcessRunning(proc.pid)) {
              try {
                await platformService.terminateProcess(proc.pid, true)
              } catch {
                // Ignore cleanup errors
              }
            }

            const portError = await checkLogForError()

            const errorDetails = [
              portError || 'InfluxDB failed to start within timeout.',
              `Binary: ${influxdbServer}`,
              `Log file: ${logFile}`,
              stderrOutput ? `Stderr:\n${stderrOutput}` : '',
              stdoutOutput ? `Stdout:\n${stdoutOutput}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        }, START_CHECK_DELAY_MS)
      })
    }

    // macOS/Linux: spawn with ignored stdio so Node.js can exit cleanly
    const proc = spawn(influxdbServer, args, {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    proc.unref()

    if (!proc.pid) {
      throw new Error('InfluxDB server process failed to start (no PID)')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // Non-fatal
    }

    // Wait for InfluxDB to be ready
    const ready = await this.waitForReady(port)

    if (ready) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // Clean up the orphaned detached process before throwing
    if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM')
        logDebug(`Killed process group ${proc.pid}`)
      } catch {
        try {
          process.kill(proc.pid, 'SIGTERM')
          logDebug(`Killed process ${proc.pid}`)
        } catch {
          // Ignore - process may have already exited
        }
      }
    }

    // Clean up PID file
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // Non-fatal
      }
    }

    const portError = await checkLogForError()

    const errorDetails = [
      portError || 'InfluxDB failed to start within timeout.',
      `Binary: ${influxdbServer}`,
      `Log file: ${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  // Wait for InfluxDB to be ready to accept connections
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        // InfluxDB 3.x health check endpoint
        const response = await influxdbApiRequest(port, 'GET', '/health')
        if (response.status === 200) {
          logDebug(`InfluxDB ready on port ${port}`)
          return true
        }
      } catch {
        // Connection failed, wait and retry
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`InfluxDB did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop InfluxDB server
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'influxdb.pid')

    logDebug(`Stopping InfluxDB container "${name}" on port ${port}`)

    // Get PID and terminate
    let pid: number | null = null

    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // Ignore
      }
    }

    // Kill process if running
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing InfluxDB process ${pid}`)
      try {
        if (isWindows()) {
          await platformService.terminateProcess(pid, true)
        } else {
          await platformService.terminateProcess(pid, false)
          await new Promise((resolve) => setTimeout(resolve, 2000))

          if (platformService.isProcessRunning(pid)) {
            logWarning(`Graceful termination failed, force killing ${pid}`)
            await platformService.terminateProcess(pid, true)
          }
        }
      } catch (error) {
        logDebug(`Process termination error: ${error}`)
      }
    }

    // Wait for process to fully terminate
    if (isWindows()) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    // Kill any processes still listening on the port
    const portPids = await platformService.findProcessByPort(port)
    for (const portPid of portPids) {
      if (platformService.isProcessRunning(portPid)) {
        logDebug(`Killing process ${portPid} still on port ${port}`)
        try {
          await platformService.terminateProcess(portPid, true)
        } catch {
          // Ignore
        }
      }
    }

    // On Windows, wait again after killing port processes
    if (isWindows() && portPids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    // Cleanup PID file
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // Ignore
      }
    }

    // On Windows, wait for ports to be released
    if (isWindows()) {
      logDebug(`Waiting for port ${port} to be released...`)
      const portWaitStart = Date.now()
      const portWaitTimeout = 30000
      const checkInterval = 500

      while (Date.now() - portWaitStart < portWaitTimeout) {
        const httpAvailable = await portManager.isPortAvailable(port)

        if (httpAvailable) {
          logDebug('Port released successfully')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logDebug('InfluxDB stopped')
  }

  // Get InfluxDB server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'influxdb.pid')

    // Try health check via REST API
    try {
      const response = await influxdbApiRequest(port, 'GET', '/health')
      if (response.status === 200) {
        return { running: true, message: 'InfluxDB is running' }
      }
    } catch {
      // Not responding, check PID
    }

    // Check PID file
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
          return {
            running: true,
            message: `InfluxDB is running (PID: ${pid})`,
          }
        }
      } catch {
        // Ignore
      }
    }

    return { running: false, message: 'InfluxDB is not running' }
  }

  // Detect backup format
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup
   * InfluxDB can be running during SQL restore (via REST API)
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name, port } = container
    const database = _options.database || container.database

    return restoreBackup(backupPath, {
      containerName: name,
      port,
      database,
    })
  }

  /**
   * Get connection string
   * Format: http://127.0.0.1:PORT
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    return `http://127.0.0.1:${port}`
  }

  // Open HTTP API (InfluxDB uses REST API)
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}`

    console.log(`InfluxDB REST API available at: ${url}`)
    console.log('')
    console.log('Example commands:')
    console.log(`  curl ${url}/health`)
    console.log(
      `  curl -X POST ${url}/api/v3/query_sql -H "Content-Type: application/json" -d '{"db":"mydb","q":"SELECT 1"}'`,
    )
  }

  /**
   * Create a new database
   * InfluxDB 3.x creates databases implicitly on first write,
   * but we can verify the server is running
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    // InfluxDB 3.x creates databases implicitly when data is written
    // Verify server is accessible and write a test record to create the database
    const response = await influxdbApiRequest(
      port,
      'POST',
      `/api/v3/write_lp?db=${encodeURIComponent(database)}`,
      undefined,
    )

    // A 204 or 200 means success, but we might also get a 2xx with empty body
    // which is fine - database will be created on first write
    if (response.status >= 400) {
      logDebug(
        `Database creation note: ${JSON.stringify(response.data)}. Database will be created on first write.`,
      )
    }

    logDebug(`InfluxDB database "${database}" ready (created on first write)`)
  }

  /**
   * Drop a database
   * InfluxDB 3.x doesn't have a direct DROP DATABASE command via REST
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    // Try to delete tables in the database
    const tablesResponse = await influxdbApiRequest(
      port,
      'POST',
      '/api/v3/query_sql',
      {
        db: database,
        q: 'SHOW TABLES',
        format: 'json',
      },
    )

    if (tablesResponse.status === 200) {
      const tables = tablesResponse.data as Array<Record<string, unknown>>
      if (Array.isArray(tables)) {
        for (const row of tables) {
          // Only drop user tables (iox schema), skip system/information_schema
          const schema = row.table_schema as string | undefined
          if (schema && schema !== 'iox') continue
          const tableName =
            (row.table_name as string) ||
            (row.name as string) ||
            (Object.values(row)[0] as string)
          if (tableName) {
            await influxdbApiRequest(port, 'POST', '/api/v3/query_sql', {
              db: database,
              q: `DROP TABLE "${tableName}"`,
              format: 'json',
            })
          }
        }
      }
    }

    logDebug(`Dropped tables in InfluxDB database: ${database}`)
  }

  /**
   * Get the storage size of the InfluxDB instance
   */
  async getDatabaseSize(_container: ContainerConfig): Promise<number | null> {
    // InfluxDB 3.x doesn't have a direct size endpoint
    // Return null to use filesystem-based calculation
    return null
  }

  /**
   * Dump from a remote InfluxDB connection
   * Uses InfluxDB's REST API to query tables and export data as SQL
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const { baseUrl, headers, database } =
      parseInfluxDBConnectionString(connectionString)

    logDebug(`Connecting to remote InfluxDB at ${baseUrl}`)

    // Check connectivity
    const healthResponse = await remoteInfluxDBRequest(
      baseUrl,
      'GET',
      '/health',
      headers,
    )
    if (healthResponse.status !== 200) {
      throw new Error(
        `Failed to connect to InfluxDB at ${baseUrl}: ${JSON.stringify(healthResponse.data)}`,
      )
    }

    const db = database || 'mydb'
    const warnings: string[] = []

    // Get list of tables
    const tablesResponse = await remoteInfluxDBRequest(
      baseUrl,
      'POST',
      '/api/v3/query_sql',
      headers,
      { db, q: 'SHOW TABLES', format: 'json' },
    )

    const tablesData = tablesResponse.data as Array<Record<string, unknown>>
    const tables: string[] = []
    if (Array.isArray(tablesData)) {
      for (const row of tablesData) {
        const schema = row.table_schema as string | undefined
        if (schema && schema !== 'iox') continue
        const tableName =
          (row.table_name as string) ||
          (row.name as string) ||
          (Object.values(row)[0] as string)
        if (tableName) tables.push(tableName)
      }
    }

    logDebug(`Found ${tables.length} tables on remote server`)

    if (tables.length === 0) {
      warnings.push(
        `Remote InfluxDB instance has no tables in database "${db}"`,
      )
    }

    // Build SQL dump (same format as local backup)
    let sqlContent = `-- InfluxDB SQL Backup\n`
    sqlContent += `-- Database: ${db}\n`
    sqlContent += `-- Source: ${baseUrl}\n`
    sqlContent += `-- Created: ${new Date().toISOString()}\n\n`

    for (const table of tables) {
      // Query column metadata for tag identification
      const tagColumns: string[] = []
      try {
        const colResponse = await remoteInfluxDBRequest(
          baseUrl,
          'POST',
          '/api/v3/query_sql',
          headers,
          {
            db,
            q: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table.replace(/'/g, "''")}'`,
            format: 'json',
          },
        )
        if (colResponse.status === 200 && Array.isArray(colResponse.data)) {
          for (const col of colResponse.data as Array<
            Record<string, unknown>
          >) {
            if (String(col.data_type || '').includes('Dictionary')) {
              tagColumns.push(String(col.column_name))
            }
          }
        }
      } catch {
        logDebug(`Warning: Could not query column metadata for ${table}`)
      }

      // Query all data from the table
      const dataResponse = await remoteInfluxDBRequest(
        baseUrl,
        'POST',
        '/api/v3/query_sql',
        headers,
        {
          db,
          q: `SELECT * FROM "${table.replace(/"/g, '""')}"`,
          format: 'json',
        },
      )

      if (dataResponse.status !== 200) {
        const msg = `Failed to export table ${table}: ${JSON.stringify(dataResponse.data)}`
        logDebug(`Warning: ${msg}`)
        warnings.push(msg)
        continue
      }

      const rows = dataResponse.data as Array<Record<string, unknown>>
      if (Array.isArray(rows) && rows.length > 0) {
        sqlContent += `-- Table: ${table}\n`
        if (tagColumns.length > 0) {
          sqlContent += `-- Tags: ${tagColumns.join(', ')}\n`
        }

        for (const row of rows) {
          const columns = Object.keys(row)
          const values = columns.map((col) => {
            const val = row[col]
            if (val === null || val === undefined) return 'NULL'
            if (typeof val === 'number') return String(val)
            if (typeof val === 'boolean') return val ? 'true' : 'false'
            return `'${String(val).replace(/'/g, "''")}'`
          })
          sqlContent += `INSERT INTO "${table.replace(/"/g, '""')}" (${columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')}) VALUES (${values.join(', ')});\n`
        }
        sqlContent += '\n'
      }
    }

    // Write SQL content to file
    await writeFile(outputPath, sqlContent, 'utf-8')

    return {
      filePath: outputPath,
      warnings,
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

  // Run a command - InfluxDB uses REST API with SQL
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container
    const database = options.database || container.database

    if (options.file) {
      // Read file content and execute as SQL
      const content = await readFile(options.file, 'utf-8')
      const statements = content
        .split('\n')
        .filter((line) => !line.startsWith('--') && line.trim().length > 0)
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      for (const sql of statements) {
        const response = await influxdbApiRequest(
          port,
          'POST',
          '/api/v3/query_sql',
          {
            db: database,
            q: sql,
            format: 'json',
          },
        )

        if (response.status >= 400) {
          throw new Error(
            `SQL error: ${JSON.stringify(response.data)}\nStatement: ${sql}`,
          )
        }
      }
      return
    }

    if (options.sql) {
      const response = await influxdbApiRequest(
        port,
        'POST',
        '/api/v3/query_sql',
        {
          db: database,
          q: options.sql,
          format: 'json',
        },
      )

      if (response.status >= 400) {
        throw new Error(`SQL error: ${JSON.stringify(response.data)}`)
      }

      if (response.data) {
        console.log(JSON.stringify(response.data, null, 2))
      }
      return
    }

    throw new Error('Either file or sql option must be provided')
  }

  /**
   * Execute a query via REST API
   *
   * Query format: SQL statement or METHOD /path [JSON body]
   * Examples:
   *   SELECT * FROM cpu
   *   GET /health
   *   POST /api/v3/query_sql {"db": "mydb", "q": "SELECT 1"}
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container
    const database = options?.database || container.database
    const trimmed = query.trim()

    // Check if this is a REST API-style query (starts with HTTP method)
    const httpMethods = ['GET', 'POST', 'PUT', 'DELETE']
    const firstWord = trimmed.split(/\s+/)[0].toUpperCase()

    if (httpMethods.includes(firstWord)) {
      // Parse as REST API query: METHOD /path [body]
      const spaceIdx = trimmed.indexOf(' ')
      const method = (options?.method || firstWord) as
        | 'GET'
        | 'POST'
        | 'PUT'
        | 'DELETE'
      const rest = trimmed.substring(spaceIdx + 1).trim()

      let path: string
      let body: Record<string, unknown> | undefined = options?.body

      const bodyStart = rest.indexOf('{')
      if (bodyStart !== -1) {
        path = rest.substring(0, bodyStart).trim()
        if (!body) {
          try {
            body = JSON.parse(rest.substring(bodyStart)) as Record<
              string,
              unknown
            >
          } catch {
            throw new Error('Invalid JSON body in query')
          }
        }
      } else {
        path = rest
      }

      if (!path.startsWith('/')) {
        path = '/' + path
      }

      const response = await influxdbApiRequest(port, method, path, body)

      if (response.status >= 400) {
        throw new Error(
          `InfluxDB API error (${response.status}): ${JSON.stringify(response.data)}`,
        )
      }

      return parseRESTAPIResult(JSON.stringify(response.data))
    }

    // Default: treat as SQL query
    const response = await influxdbApiRequest(
      port,
      'POST',
      '/api/v3/query_sql',
      {
        db: database,
        q: trimmed,
        format: 'json',
      },
    )

    if (response.status >= 400) {
      throw new Error(
        `InfluxDB SQL error (${response.status}): ${JSON.stringify(response.data)}`,
      )
    }

    return parseRESTAPIResult(JSON.stringify(response.data))
  }

  /**
   * List databases for InfluxDB.
   * InfluxDB 3.x uses GET /api/v3/configure/database?format=json
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { port } = container

    try {
      const response = await influxdbApiRequest(
        port,
        'GET',
        '/api/v3/configure/database?format=json',
      )

      if (response.status === 200 && response.data) {
        const data = response.data as Array<Record<string, unknown>>
        if (Array.isArray(data)) {
          const databases = data
            .map((row) => {
              return (
                (row['iox::database'] as string) ||
                (row.name as string) ||
                (Object.values(row)[0] as string)
              )
            })
            .filter(Boolean)
          return databases.length > 0 ? databases : [container.database]
        }
      }
      return [container.database]
    } catch {
      return [container.database]
    }
  }
}

export const influxdbEngine = new InfluxDBEngine()
