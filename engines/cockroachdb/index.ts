/**
 * CockroachDB Engine Implementation
 *
 * CockroachDB is a distributed SQL database with PostgreSQL wire protocol compatibility.
 * It provides horizontal scaling, strong consistency, and built-in survivability.
 *
 * Key characteristics:
 * - Default SQL port: 26257
 * - HTTP UI port: SQL port + 1 (default 26258)
 * - Uses PostgreSQL wire protocol for client connections
 * - Single binary: `cockroach` (handles server, sql client, and admin tasks)
 * - Default database: `defaultdb`
 * - Default user: `root` (no password in insecure mode)
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { findBinary } from '../../core/dependency-manager'
import { processManager } from '../../core/process-manager'
import { cockroachdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  COCKROACHDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  validateCockroachIdentifier,
  escapeCockroachIdentifier,
  escapeSqlValue,
  parseCsvLine,
  parseCsvRecords,
  isInsecureConnection,
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
} from '../../types'

const ENGINE = 'cockroachdb'
const engineDef = getEngineDefaults(ENGINE)

export class CockroachDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'CockroachDB'
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

  // Resolves version string to full version (e.g., '25' -> '25.4.2')
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return COCKROACHDB_VERSION_MAP[version] || version
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'cockroachdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that CockroachDB binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const cockroachPath = join(binPath, 'bin', `cockroach${ext}`)
    return existsSync(cockroachPath)
  }

  // Check if a specific CockroachDB version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return cockroachdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure CockroachDB binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await cockroachdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binary in config
    const ext = platformService.getExecutableExtension()
    const cockroachPath = join(binPath, 'bin', `cockroach${ext}`)
    if (existsSync(cockroachPath)) {
      await configManager.setBinaryPath('cockroach', cockroachPath, 'bundled')
    }

    return binPath
  }

  /**
   * Initialize a new CockroachDB data directory
   * Creates the directory structure for CockroachDB's storage
   */
  async initDataDir(
    containerName: string,
    _version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    // Create data directory
    await mkdir(dataDir, { recursive: true })

    logDebug(`Created CockroachDB data directory: ${dataDir}`)

    return dataDir
  }

  // Get the path to cockroach binary for a version
  async getCockroachPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'cockroachdb',
      version: fullVersion,
      platform,
      arch,
    })
    const cockroachPath = join(binPath, 'bin', `cockroach${ext}`)

    if (existsSync(cockroachPath)) {
      return cockroachPath
    }

    throw new Error(
      `CockroachDB ${version} is not installed. Run: spindb engines download cockroachdb ${version}`,
    )
  }

  /**
   * Start CockroachDB server
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

    // Get CockroachDB binary path
    let cockroachBinary: string | null = null
    const ext = platformService.getExecutableExtension()

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(binaryPath, 'bin', `cockroach${ext}`)
      if (existsSync(serverPath)) {
        cockroachBinary = serverPath
        logDebug(`Using stored binary path: ${cockroachBinary}`)
      }
    }

    if (!cockroachBinary) {
      try {
        cockroachBinary = await this.getCockroachPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `CockroachDB ${version} is not installed. Run: spindb engines download cockroachdb ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = join(containerDir, 'cockroach.log')
    const pidFile = join(containerDir, 'cockroach.pid')
    const httpPort = port + 1 // HTTP admin UI port

    onProgress?.({ stage: 'starting', message: 'Starting CockroachDB...' })

    logDebug(`Starting CockroachDB with data dir: ${dataDir}`)

    // CockroachDB start command
    // Using --insecure for local development (no TLS)
    const args = [
      'start-single-node',
      '--insecure',
      '--store', dataDir,
      '--listen-addr', `127.0.0.1:${port}`,
      '--http-addr', `127.0.0.1:${httpPort}`,
      '--pid-file', pidFile,
      '--log-dir', containerDir,
    ]

    // On Unix, use --background flag which forks a daemon process
    // On Windows, don't use --background - Windows doesn't have the same fork model
    // and CockroachDB's background mode can fail silently. Instead, we detach manually.
    const isWindows = process.platform === 'win32'
    if (!isWindows) {
      args.push('--background')
    }

    // IMPORTANT: Use 'ignore' for all stdio on all platforms.
    // Using 'pipe' keeps file descriptors open which prevents proc.unref() from
    // allowing Node.js to exit, causing spawn timeouts even when the process starts successfully.
    const proc = spawn(cockroachBinary!, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      // On Windows, set cwd to container directory to ensure proper file handle behavior
      cwd: isWindows ? containerDir : undefined,
      // On Windows, hide the console window to prevent it from blocking
      windowsHide: true,
    })

    // On Windows without --background, write PID file ourselves
    // (On Unix, --background makes CockroachDB write the daemon PID)
    if (isWindows && proc.pid) {
      try {
        await writeFile(pidFile, proc.pid.toString(), 'utf-8')
        logDebug(`Wrote PID file: ${pidFile} (pid: ${proc.pid})`)
      } catch (err) {
        logDebug(`Failed to write PID file: ${err instanceof Error ? err.message : String(err)}`)
        // Continue anyway - the process is running
      }
    }

    // Wait for the process to spawn
    // On Windows, the 'spawn' event doesn't fire reliably with detached processes,
    // so we use a simple delay and let waitForReady() handle detection.
    // On Unix with --background, we wait for the spawn event.
    if (isWindows) {
      // Add error handler to catch spawn failures on Windows
      await new Promise<void>((resolve, reject) => {
        proc.on('error', (err) => {
          logDebug(`CockroachDB spawn error on Windows: ${err}`)
          reject(err)
        })
        proc.unref()
        logDebug(`Windows: waiting fixed delay for CockroachDB to start (pid: ${proc.pid})`)
        setTimeout(resolve, 3000)
      })
    } else {
      const spawnTimeout = 30000 // 30 seconds to spawn
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`CockroachDB process failed to spawn within ${spawnTimeout}ms`))
        }, spawnTimeout)

        proc.on('error', (err) => {
          clearTimeout(timeoutId)
          logDebug(`CockroachDB spawn error: ${err}`)
          reject(err)
        })
        proc.on('spawn', () => {
          clearTimeout(timeoutId)
          logDebug(`CockroachDB process spawned (pid: ${proc.pid})`)
          proc.unref()
          setTimeout(resolve, 500)
        })
      })
    }

    // Wait for server to be ready
    // Windows needs a longer timeout since CockroachDB initialization takes more time
    const timeout = isWindows ? 90000 : 60000
    logDebug(`Waiting for CockroachDB server to be ready on port ${port}... (timeout: ${timeout}ms)`)
    const ready = await this.waitForReady(port, version, timeout)
    logDebug(`waitForReady returned: ${ready}`)

    if (!ready) {
      // Clean up the spawned process and PID file before throwing
      try {
        const pidStr = await readFile(pidFile, 'utf-8').catch(() => null)
        if (pidStr) {
          const pid = parseInt(pidStr.trim(), 10)
          if (!isNaN(pid)) {
            logDebug(`Cleaning up failed CockroachDB process (pid: ${pid})`)
            await platformService.terminateProcess(pid, true)
          }
        }
        await unlink(pidFile).catch(() => {})
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(
        `CockroachDB failed to start within timeout. Check logs at: ${logFile}`,
      )
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // Wait for CockroachDB to be ready
  private async waitForReady(
    port: number,
    version: string,
    timeoutMs = 60000,
  ): Promise<boolean> {
    logDebug(`waitForReady called for port ${port}, version ${version}`)
    const startTime = Date.now()
    const checkInterval = 500

    let cockroach: string
    try {
      logDebug('Getting cockroach binary path...')
      cockroach = await this.getCockroachPath(version)
      logDebug(`Got cockroach binary path: ${cockroach}`)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logDebug(`Error getting cockroach binary path: ${errorMessage}`)
      logWarning(
        `CockroachDB binary not found, cannot verify server is ready: ${errorMessage}`,
      )
      return false
    }

    logDebug(`Starting connection loop, timeout: ${timeoutMs}ms`)
    let attempt = 0
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      logDebug(`Connection attempt ${attempt}...`)
      try {
        const args = [
          'sql',
          '--insecure',
          '--host',
          `127.0.0.1:${port}`,
          '--execute',
          'SELECT 1',
        ]
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(cockroach, args, {
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
        logDebug(`CockroachDB ready on port ${port}`)
        return true
      } catch (err) {
        logDebug(`Attempt ${attempt} failed: ${err}`)
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`CockroachDB did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop CockroachDB server
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'cockroach.pid')

    logDebug(`Stopping CockroachDB container "${name}" on port ${port}`)

    // Find PID by checking the process using cross-platform helper
    let pid: number | null = null

    // Try to find CockroachDB process by port
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
      logDebug(`Killing CockroachDB process ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        // Wait for graceful termination
        // On Windows, CockroachDB's RocksDB uses memory-mapped files that
        // take longer to release, so we wait longer to avoid EBUSY errors
        const gracefulWait = process.platform === 'win32' ? 5000 : 2000
        await new Promise((resolve) => setTimeout(resolve, gracefulWait))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`Graceful termination failed, force killing ${pid}`)
          await platformService.terminateProcess(pid, true)
          // Additional wait after force kill on Windows for file handle release
          if (process.platform === 'win32') {
            await new Promise((resolve) => setTimeout(resolve, 3000))
          }
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

    logDebug('CockroachDB stopped')
  }

  // Get CockroachDB server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { port, version } = container

    // Try to connect
    try {
      const cockroach = await this.getCockroachPath(version)
      const args = [
        'sql',
        '--insecure',
        '--host',
        `127.0.0.1:${port}`,
        '--execute',
        'SELECT 1',
      ]
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cockroach, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Exit code ${code}`))
        })
        proc.on('error', reject)
      })
      return { running: true, message: 'CockroachDB is running' }
    } catch {
      return { running: false, message: 'CockroachDB is not running' }
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
      database: options.database || container.database || 'defaultdb',
      version,
      clean: options.clean,
    })
  }

  /**
   * Get connection string
   * Format: postgresql://root@127.0.0.1:PORT/DATABASE?sslmode=disable
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'defaultdb'
    return `postgresql://root@127.0.0.1:${port}/${db}?sslmode=disable`
  }

  // Open cockroach sql interactive shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port, version } = container
    const db = database || container.database || 'defaultdb'

    const cockroach = await this.getCockroachPath(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        cockroach,
        ['sql', '--insecure', '--host', `127.0.0.1:${port}`, '--database', db],
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
    validateCockroachIdentifier(database, 'database')
    const escapedDb = escapeCockroachIdentifier(database)

    const cockroach = await this.getCockroachPath(version)

    const args = [
      'sql',
      '--insecure',
      '--host',
      `127.0.0.1:${port}`,
      '--execute',
      `CREATE DATABASE IF NOT EXISTS ${escapedDb}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cockroach, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Created CockroachDB database: ${database}`)
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

    // Don't allow dropping system databases
    const systemDatabases = ['defaultdb', 'postgres', 'system']
    if (systemDatabases.includes(database.toLowerCase())) {
      throw new Error(`Cannot drop system database: ${database}`)
    }

    // Validate database identifier to prevent SQL injection
    validateCockroachIdentifier(database, 'database')
    const escapedDb = escapeCockroachIdentifier(database)

    const cockroach = await this.getCockroachPath(version)

    const args = [
      'sql',
      '--insecure',
      '--host',
      `127.0.0.1:${port}`,
      '--execute',
      `DROP DATABASE IF EXISTS ${escapedDb}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cockroach, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Dropped CockroachDB database: ${database}`)
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
    const db = database || 'defaultdb'

    try {
      const cockroach = await this.getCockroachPath(version)
      validateCockroachIdentifier(db, 'database')

      // CockroachDB query to get database size
      const query = `SELECT sum(range_size_mb) * 1024 * 1024 as size_bytes FROM [SHOW RANGES FROM DATABASE ${escapeCockroachIdentifier(db)}]`

      const result = await new Promise<string>((resolve, reject) => {
        const args = [
          'sql',
          '--insecure',
          '--host',
          `127.0.0.1:${port}`,
          '--database',
          db,
          '--execute',
          query,
          '--format=csv',
        ]

        const proc = spawn(cockroach, args, {
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

      // Parse CSV output - skip header
      const lines = result.split('\n')
      if (lines.length >= 2) {
        const size = parseFloat(lines[1])
        return isNaN(size) ? null : Math.round(size)
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote CockroachDB connection
   * Uses cockroach sql to export schema and data
   *
   * Connection string format: postgresql://[user[:password]@]host[:port][/database][?sslmode=...]
   *
   * Supports both insecure (local dev) and secure (production) connections:
   * - sslmode=disable or localhost without sslmode: uses --insecure flag
   * - Other SSL modes: passes connection string directly (handles certs via URL params)
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // Parse connection string
    let url: URL
    try {
      url = new URL(connectionString)
    } catch {
      // Redact credentials before including in error message
      const sanitized = connectionString.replace(/\/\/([^@]+)@/, '//***@')
      throw new Error(
        `Invalid connection string: ${sanitized}\n` +
          'Expected format: postgresql://[user[:password]@]host[:port][/database][?sslmode=...]',
      )
    }

    const host = url.hostname || '127.0.0.1'
    const port = parseInt(url.port, 10) || 26257
    const database = url.pathname.replace(/^\//, '') || 'defaultdb'

    logDebug(`Connecting to remote CockroachDB at ${host}:${port} (db: ${database})`)

    // For remote dump, we need a local cockroach binary
    // Try multiple methods to find an installed version
    let cockroach: string | null = null

    // 1. Try 'cockroach' key in config
    const cachedCockroach = await configManager.getBinaryPath('cockroach')
    if (cachedCockroach && existsSync(cachedCockroach)) {
      cockroach = cachedCockroach
      logDebug(`Found cockroach binary via 'cockroach' config key: ${cockroach}`)
    }

    // 2. Try to find via dependency manager (checks config + system PATH)
    if (!cockroach) {
      const binaryResult = await findBinary('cockroach')
      if (binaryResult?.path && existsSync(binaryResult.path)) {
        cockroach = binaryResult.path
        logDebug(`Found cockroach binary via dependency manager: ${cockroach}`)
      }
    }

    // 3. Try to use any downloaded version via getCockroachPath
    if (!cockroach) {
      for (const version of SUPPORTED_MAJOR_VERSIONS) {
        try {
          cockroach = await this.getCockroachPath(version)
          logDebug(`Found cockroach binary for version ${version}: ${cockroach}`)
          break
        } catch {
          // Version not installed, try next
        }
      }
    }

    if (!cockroach) {
      throw new Error(
        'CockroachDB binary not found. Run: spindb engines download cockroachdb 25\n' +
          'A local CockroachDB binary is needed to dump from remote connections.',
      )
    }

    const lines: string[] = []
    lines.push('-- CockroachDB backup generated by SpinDB')
    lines.push(`-- Source: ${host}:${port}`)
    lines.push(`-- Database: ${database}`)
    lines.push(`-- Date: ${new Date().toISOString()}`)
    lines.push('')

    // Build connection args using --url to preserve auth/SSL settings
    const connArgs = ['sql', '--url', connectionString]

    // Only add --insecure for local dev or explicit sslmode=disable
    if (isInsecureConnection(connectionString)) {
      connArgs.push('--insecure')
    }

    // Get list of tables
    const tablesQuery = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
    const tablesResult = await this.execRemoteQuery(cockroach, connArgs, tablesQuery)
    // Parse CSV output properly to handle quoted identifiers
    const tableRecords = parseCsvRecords(tablesResult, true) // Skip header
    const tables = tableRecords
      .map((line) => {
        const fields = parseCsvLine(line)
        return fields.length > 0 ? fields[0].value : ''
      })
      .filter((t) => t)

    logDebug(`Found ${tables.length} tables in database ${database}`)

    for (const table of tables) {
      // Table names from information_schema are safe (already unquoted by CSV parser)
      // Only validate that we got a non-empty name
      if (!table) {
        continue
      }

      lines.push(`-- Table: ${table}`)
      lines.push('')

      // Get CREATE TABLE - use proper identifier escaping
      try {
        const createQuery = `SHOW CREATE TABLE ${escapeCockroachIdentifier(table)}`
        const createResult = await this.execRemoteQuery(cockroach, connArgs, createQuery)
        // Parse CSV output safely using record-aware parser
        // Format is: table_name,create_statement (create statement may contain newlines)
        const createRecords = parseCsvRecords(createResult, true) // Skip header
        if (createRecords.length > 0) {
          const columns = parseCsvLine(createRecords[0])
          if (columns.length >= 2) {
            // Second column is the CREATE TABLE statement
            const createStatement = columns[1].value.trim()
            lines.push(createStatement + ';')
          } else {
            logWarning(`Unexpected SHOW CREATE TABLE output for ${table}`)
          }
        }
        lines.push('')
      } catch (error) {
        logWarning(`Could not get CREATE TABLE for ${table}: ${error}`)
        continue
      }

      // Export table data
      try {
        // Get column names first
        // Escape single quotes in table name for string literal comparison
        const escapedTableForString = table.replace(/'/g, "''")
        const columnsQuery = `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${escapedTableForString}' ORDER BY ordinal_position`
        const columnsResult = await this.execRemoteQuery(cockroach, connArgs, columnsQuery)
        // Parse each CSV record properly to handle quoted column names
        const columnRecords = parseCsvRecords(columnsResult, true) // Skip header
        const columns = columnRecords
          .map((record) => {
            const fields = parseCsvLine(record)
            return fields.length > 0 ? fields[0].value.trim() : ''
          })
          .filter((c) => c)

        if (columns.length === 0) {
          logDebug(`No columns found for table ${table}, skipping data export`)
          continue
        }

        // Get all rows - use proper identifier escaping
        const dataQuery = `SELECT * FROM ${escapeCockroachIdentifier(table)}`
        const dataResult = await this.execRemoteQuery(cockroach, connArgs, dataQuery)
        // Use record-aware parser to handle fields with embedded newlines
        const dataRecords = parseCsvRecords(dataResult, true) // Skip header

        if (dataRecords.length > 0) {
          lines.push(`-- Data for ${table}`)

          for (const dataRecord of dataRecords) {
            const fields = parseCsvLine(dataRecord)
            if (fields.length !== columns.length) {
              logWarning(
                `Column count mismatch for table ${table}: expected ${columns.length}, got ${fields.length}`,
              )
              continue
            }

            const escapedCols = columns.map((c) => escapeCockroachIdentifier(c)).join(', ')
            const escapedVals = fields
              .map((f) => escapeSqlValue(f.value, f.wasQuoted))
              .join(', ')
            lines.push(
              `INSERT INTO ${escapeCockroachIdentifier(table)} (${escapedCols}) VALUES (${escapedVals});`,
            )
          }
          lines.push('')
        }
      } catch (error) {
        logWarning(`Could not export data for table ${table}: ${error}`)
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

  // Helper to execute a query on a remote CockroachDB
  private async execRemoteQuery(
    cockroach: string,
    connArgs: string[],
    query: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [...connArgs, '--execute', query, '--format=csv']

      const proc = spawn(cockroach, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(stderr || `Exit code ${code}`))
        }
      })
      proc.on('error', reject)
    })
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
    const db = options.database || container.database || 'defaultdb'

    const cockroach = await this.getCockroachPath(version)

    if (options.file) {
      // Run SQL file
      const args = [
        'sql',
        '--insecure',
        '--host',
        `127.0.0.1:${port}`,
        '--database',
        db,
        '--file',
        options.file,
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cockroach, args, {
          stdio: 'inherit',
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else if (code === null) {
            reject(new Error('cockroach sql was terminated by a signal'))
          } else {
            reject(new Error(`cockroach sql exited with code ${code}`))
          }
        })
      })
    } else if (options.sql) {
      // Run inline SQL via stdin
      const args = [
        'sql',
        '--insecure',
        '--host',
        `127.0.0.1:${port}`,
        '--database',
        db,
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cockroach, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else if (code === null) {
            reject(new Error('cockroach sql was terminated by a signal'))
          } else {
            reject(new Error(`cockroach sql exited with code ${code}`))
          }
        })

        proc.stdin?.write(options.sql)
        proc.stdin?.end()
      })
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }
}

export const cockroachdbEngine = new CockroachDBEngine()
