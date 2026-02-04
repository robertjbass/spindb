/**
 * QuestDB Engine Implementation
 *
 * QuestDB is a high-performance time-series database with built-in support for
 * SQL queries via PostgreSQL wire protocol.
 *
 * Key characteristics:
 * - Default PostgreSQL wire protocol port: 8812
 * - Default HTTP port: 9000 (REST API and Web Console)
 * - Default ILP (InfluxDB Line Protocol) port: 9009
 * - Java-based with bundled JRE (no Java installation required)
 * - Startup script: questdb.sh (Unix) or questdb.exe (Windows)
 * - Default database: qdb (root database)
 * - Default user: admin (password: quest)
 * - Query language: SQL (with time-series extensions)
 * - Web Console at http://localhost:9000
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { findBinary } from '../../core/dependency-manager'
import { processManager } from '../../core/process-manager'
import { questdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  QUESTDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
  parseConnectionString,
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
  type QueryResult,
  type QueryOptions,
} from '../../types'
import { parseCSVToQueryResult } from '../../core/query-parser'

const ENGINE = 'questdb'
const engineDef = getEngineDefaults(ENGINE)

export class QuestDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'QuestDB'
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

  // Resolves version string to full version (e.g., '9' -> '9.2.3')
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return QUESTDB_VERSION_MAP[version] || version
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'questdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that QuestDB binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    // Check both root and bin/ subdirectory (structure differs by platform)
    const { platform } = this.getPlatformInfo()
    if (platform === 'win32') {
      const exePathRoot = join(binPath, 'questdb.exe')
      const exePathBin = join(binPath, 'bin', 'questdb.exe')
      return existsSync(exePathRoot) || existsSync(exePathBin)
    } else {
      const shPathRoot = join(binPath, 'questdb.sh')
      const shPathBin = join(binPath, 'bin', 'questdb.sh')
      return existsSync(shPathRoot) || existsSync(shPathBin)
    }
  }

  // Check if a specific QuestDB version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return questdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure QuestDB binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the installation directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await questdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Ensure startup script is executable
    await questdbBinaryManager.postExtract(binPath, platform)

    // Register the startup script in config
    // Register the startup script in config - check both locations
    if (platform === 'win32') {
      const exePathRoot = join(binPath, 'questdb.exe')
      const exePathBin = join(binPath, 'bin', 'questdb.exe')
      const exePath = existsSync(exePathRoot) ? exePathRoot : exePathBin
      if (existsSync(exePath)) {
        await configManager.setBinaryPath('questdb', exePath, 'bundled')
      }
    } else {
      const shPathRoot = join(binPath, 'questdb.sh')
      const shPathBin = join(binPath, 'bin', 'questdb.sh')
      const shPath = existsSync(shPathRoot) ? shPathRoot : shPathBin
      if (existsSync(shPath)) {
        await configManager.setBinaryPath('questdb', shPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * Initialize a new QuestDB data directory
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

    logDebug(`Created QuestDB data directory: ${dataDir}`)

    return dataDir
  }

  // Get the path to QuestDB startup script for a version
  async getQuestDBPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)

    const binPath = paths.getBinaryPath({
      engine: 'questdb',
      version: fullVersion,
      platform,
      arch,
    })

    // Check both root and bin/ subdirectory (structure differs by platform)
    if (platform === 'win32') {
      const exePathRoot = join(binPath, 'questdb.exe')
      const exePathBin = join(binPath, 'bin', 'questdb.exe')
      if (existsSync(exePathRoot)) return exePathRoot
      if (existsSync(exePathBin)) return exePathBin
    } else {
      const shPathRoot = join(binPath, 'questdb.sh')
      const shPathBin = join(binPath, 'bin', 'questdb.sh')
      if (existsSync(shPathRoot)) return shPathRoot
      if (existsSync(shPathBin)) return shPathBin
    }

    throw new Error(
      `QuestDB ${version} is not installed. Run: spindb engines download questdb ${version}`,
    )
  }

  /**
   * Start QuestDB server
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

    // Get QuestDB binary path - check both root and bin/ subdirectory
    let questdbBinary: string | null = null
    const { platform } = this.getPlatformInfo()

    if (binaryPath && existsSync(binaryPath)) {
      if (platform === 'win32') {
        const exePathRoot = join(binaryPath, 'questdb.exe')
        const exePathBin = join(binaryPath, 'bin', 'questdb.exe')
        if (existsSync(exePathRoot)) {
          questdbBinary = exePathRoot
          logDebug(`Using stored binary path: ${questdbBinary}`)
        } else if (existsSync(exePathBin)) {
          questdbBinary = exePathBin
          logDebug(`Using stored binary path (bin/): ${questdbBinary}`)
        }
      } else {
        const shPathRoot = join(binaryPath, 'questdb.sh')
        const shPathBin = join(binaryPath, 'bin', 'questdb.sh')
        if (existsSync(shPathRoot)) {
          questdbBinary = shPathRoot
          logDebug(`Using stored binary path: ${questdbBinary}`)
        } else if (existsSync(shPathBin)) {
          questdbBinary = shPathBin
          logDebug(`Using stored binary path (bin/): ${questdbBinary}`)
        }
      }
    }

    if (!questdbBinary) {
      try {
        questdbBinary = await this.getQuestDBPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `QuestDB ${version} is not installed. Run: spindb engines download questdb ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'questdb.pid')

    // Calculate HTTP port (default is PG port + 188, i.e., 8812 + 188 = 9000)
    const httpPort = port + 188

    onProgress?.({ stage: 'starting', message: 'Starting QuestDB...' })

    logDebug(`Starting QuestDB with data dir: ${dataDir}`)

    const isWindows = platform === 'win32'

    // QuestDB startup command
    // Windows: questdb.exe doesn't support 'start' subcommand reliably (GitHub #1222)
    //          Run without 'start' command - it starts in interactive/foreground mode
    // Unix: questdb.sh start -d ... -t ... -n daemonizes properly
    // -t tag: Unique process tag allows multiple QuestDB instances to run simultaneously
    //         Without this, QuestDB detects other instances by process label and refuses to start
    const args = isWindows
      ? ['-d', dataDir, '-t', name] // Windows: no 'start' command, no '-n' flag
      : ['start', '-d', dataDir, '-t', name, '-n'] // Unix: full daemon mode

    // Environment variables for QuestDB configuration
    // Note: Don't set QDB_LOG_W_FILE_LOCATION - QuestDB expects rolling log patterns with $
    // Logs are written to dataDir/log/ by default
    //
    // Port offsets from base PostgreSQL port:
    // - HTTP Server: +188 (default 9000)
    // - HTTP Min Server: +191 (default 9003) - for health checks/metrics
    // - ILP TCP: +197 (default 9009)
    const env = {
      ...process.env,
      QDB_HTTP_BIND_TO: `0.0.0.0:${httpPort}`,
      QDB_HTTP_MIN_NET_BIND_TO: `0.0.0.0:${port + 191}`, // HTTP Min Server (health/metrics)
      QDB_PG_NET_BIND_TO: `0.0.0.0:${port}`,
      QDB_LINE_TCP_NET_BIND_TO: `0.0.0.0:${port + 197}`, // ILP port
    }

    // IMPORTANT: Use 'ignore' for all stdio to prevent hanging
    // QuestDB runs as a daemon and we don't want to keep file descriptors open
    const spawnOptions: SpawnOptions = {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      cwd: containerDir,
      env,
      windowsHide: true,
    }

    logDebug(`Spawning QuestDB: ${questdbBinary} ${args.join(' ')}`)

    const proc = spawn(questdbBinary, args, spawnOptions)

    // Allow the process to detach immediately
    // Note: We don't write the PID file here because questdb.sh forks the Java
    // process and exits. The shell's PID becomes invalid immediately.
    // QuestDB writes its own PID file to {dataDir}/questdb.pid which we'll
    // read after waiting for the server to be ready.
    proc.unref()

    // Wait for server to be ready
    const timeout = isWindows ? 90000 : 60000
    logDebug(
      `Waiting for QuestDB to be ready on port ${port}... (timeout: ${timeout}ms)`,
    )

    // Give QuestDB a moment to start before checking
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const ready = await this.waitForReady(port, version, timeout)
    logDebug(`waitForReady returned: ${ready}`)

    if (!ready) {
      // Clean up on failure - try to find and kill the QuestDB process by port
      try {
        const pids = await platformService.findProcessByPort(port)
        if (pids.length > 0) {
          logDebug(`Cleaning up failed QuestDB process (pid: ${pids[0]})`)
          await platformService.terminateProcess(pids[0], true)
        }
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(
        `QuestDB failed to start within timeout. Check logs at: ${dataDir}/log/`,
      )
    }

    // QuestDB is ready - find the actual Java process PID by port
    // QuestDB doesn't create a PID file in daemon mode, so we find the process by port
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        const actualPid = pids[0]
        await writeFile(pidFile, actualPid.toString(), 'utf-8')
        logDebug(`Wrote PID file: ${pidFile} (pid: ${actualPid})`)
      } else {
        logDebug(
          'Could not find QuestDB process by port - PID file not created',
        )
      }
    } catch (err) {
      logDebug(
        `Could not find QuestDB PID: ${err instanceof Error ? err.message : String(err)}`,
      )
      // Don't fail - QuestDB is running, we just can't track its PID
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // Wait for QuestDB to be ready using psql
  private async waitForReady(
    port: number,
    version: string,
    timeoutMs = 60000,
  ): Promise<boolean> {
    logDebug(`waitForReady called for port ${port}`)
    const startTime = Date.now()
    const checkInterval = 500

    // Try to find psql for connection checking
    let psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      // Try system psql
      try {
        const result = await findBinary('psql')
        if (result?.path) {
          psqlPath = result.path
        }
      } catch {
        // Ignore
      }
    }

    // If no psql, try HTTP health check instead
    if (!psqlPath) {
      logDebug('psql not found, using HTTP health check')
      return this.waitForReadyHttp(port + 188, timeoutMs)
    }

    let attempt = 0
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      logDebug(`Connection attempt ${attempt}...`)
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(
            psqlPath!,
            [
              '-h',
              '127.0.0.1',
              '-p',
              String(port),
              '-U',
              'admin',
              '-d',
              'qdb',
              '-c',
              'SELECT 1;',
            ],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, PGPASSWORD: 'quest' },
            },
          )

          proc.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Exit code ${code}`))
          })
          proc.on('error', reject)
        })
        logDebug(`QuestDB ready on port ${port}`)
        return true
      } catch (err) {
        logDebug(`Attempt ${attempt} failed: ${err}`)
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`QuestDB did not become ready within ${timeoutMs}ms`)
    return false
  }

  // Fallback: wait using HTTP health check
  private async waitForReadyHttp(
    httpPort: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${httpPort}/exec?query=SELECT%201`,
        )
        if (response.ok) {
          logDebug(`QuestDB HTTP ready on port ${httpPort}`)
          return true
        }
      } catch {
        // Not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    return false
  }

  /**
   * Stop QuestDB server
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'questdb.pid')

    logDebug(`Stopping QuestDB container "${name}" on port ${port}`)

    // Try to find process by port first (most reliable)
    // QuestDB doesn't create a PID file, so port lookup is primary
    let pid: number | null = null
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        pid = pids[0]
      }
    } catch {
      // Fall back to our PID file
      try {
        const pidStr = await readFile(pidFile, 'utf-8')
        const parsedPid = parseInt(pidStr.trim(), 10)
        if (!isNaN(parsedPid)) {
          pid = parsedPid
        }
      } catch {
        // Ignore
      }
    }

    // Kill process if found
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing QuestDB process ${pid}`)
      const { platform } = this.getPlatformInfo()
      const isWindows = platform === 'win32'

      try {
        await platformService.terminateProcess(pid, false)
        // Wait for graceful termination - Windows needs more time for Java to release file locks
        const gracefulWait = isWindows ? 5000 : 2000
        await new Promise((resolve) => setTimeout(resolve, gracefulWait))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`Graceful termination failed, force killing ${pid}`)
          await platformService.terminateProcess(pid, true)
          // Additional wait after force kill on Windows
          if (isWindows) {
            await new Promise((resolve) => setTimeout(resolve, 2000))
          }
        }
      } catch (error) {
        logDebug(`Process termination error: ${error}`)
      }
    }

    // Cleanup our PID file
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // Ignore
      }
    }

    logDebug('QuestDB stopped')
  }

  // Get QuestDB server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { port } = container

    // Try HTTP health check first
    const httpPort = port + 188
    try {
      const response = await fetch(
        `http://127.0.0.1:${httpPort}/exec?query=SELECT%201`,
      )
      if (response.ok) {
        return { running: true, message: 'QuestDB is running' }
      }
    } catch {
      // Not running or not responding
    }

    return { running: false, message: 'QuestDB is not running' }
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
      database: options.database || container.database || 'qdb',
      version,
      clean: options.clean,
    })
  }

  /**
   * Get connection string
   * Format: postgresql://admin:quest@127.0.0.1:PORT/DATABASE
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'qdb'
    return `postgresql://admin:quest@127.0.0.1:${port}/${db}`
  }

  // Open psql interactive shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || container.database || 'qdb'

    // Find psql
    let psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      const result = await findBinary('psql')
      if (result?.path) {
        psqlPath = result.path
      } else {
        throw new Error(
          'psql not found. Install PostgreSQL client tools or use the Web Console at ' +
            `http://127.0.0.1:${port + 188}`,
        )
      }
    }

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      env: { ...process.env, PGPASSWORD: 'quest' },
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        psqlPath!,
        ['-h', '127.0.0.1', '-p', String(port), '-U', 'admin', '-d', db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * Create a new database
   * Note: QuestDB has a single-database model but supports schemas
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    logDebug(
      `QuestDB uses a single-database model. Database "${database}" will be a schema.`,
    )
    // QuestDB doesn't have traditional CREATE DATABASE
    // All tables exist in the default database
  }

  /**
   * Drop a database (schema in QuestDB)
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    logDebug(
      `QuestDB uses a single-database model. Cannot drop database "${database}".`,
    )
  }

  /**
   * Get the database size
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const dataDir = paths.getContainerDataPath(container.name, {
      engine: ENGINE,
    })
    if (!existsSync(dataDir)) return null

    try {
      let totalSize = 0
      const entries = await readdir(dataDir, {
        withFileTypes: true,
        recursive: true,
      })
      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = join(entry.parentPath ?? dataDir, entry.name)
          const stats = await stat(filePath)
          totalSize += stats.size
        }
      }
      return totalSize
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote QuestDB connection
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const { host, port, database, user, password } =
      parseConnectionString(connectionString)

    logDebug(
      `Connecting to remote QuestDB at ${host}:${port} (db: ${database})`,
    )

    // Find psql for remote operations
    let psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      const result = await findBinary('psql')
      if (result?.path) {
        psqlPath = result.path
      } else {
        throw new Error(
          'psql not found. Install PostgreSQL client tools to dump from remote QuestDB.',
        )
      }
    }

    const lines: string[] = []
    lines.push('-- QuestDB backup generated by SpinDB')
    lines.push(`-- Source: ${host}:${port}`)
    lines.push(`-- Database: ${database}`)
    lines.push(`-- Date: ${new Date().toISOString()}`)
    lines.push('')

    // Get list of tables
    const tablesQuery = `SELECT table_name FROM tables() WHERE table_name NOT LIKE 'sys.%'`
    const tablesResult = await this.execRemoteQuery(
      psqlPath,
      host,
      port,
      user,
      password ?? '',
      database,
      tablesQuery,
    )
    const tables = tablesResult.split('\n').filter((t) => t.trim())

    logDebug(`Found ${tables.length} tables`)

    for (const table of tables) {
      if (!table.trim()) continue

      lines.push(`-- Table: ${table}`)
      lines.push('')

      try {
        const createQuery = `SHOW CREATE TABLE "${table}"`
        const createResult = await this.execRemoteQuery(
          psqlPath,
          host,
          port,
          user,
          password ?? '',
          database,
          createQuery,
        )
        if (createResult) {
          lines.push(createResult + ';')
          lines.push('')
        }
      } catch (error) {
        logWarning(`Could not get CREATE TABLE for ${table}: ${error}`)
      }
    }

    const content = lines.join('\n')
    await writeFile(outputPath, content, 'utf-8')

    return {
      filePath: outputPath,
      warnings:
        tables.length === 0 ? ['No tables found in database'] : undefined,
    }
  }

  private async execRemoteQuery(
    psqlPath: string,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
    query: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-h',
        host,
        '-p',
        String(port),
        '-U',
        user,
        '-d',
        database,
        '-t',
        '-A',
        '-c',
        query,
      ]

      const proc = spawn(psqlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PGPASSWORD: password },
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
          resolve(stdout.trim())
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
    const { port } = container
    const db = options.database || container.database || 'qdb'

    // Find psql
    let psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      const result = await findBinary('psql')
      if (result?.path) {
        psqlPath = result.path
      } else {
        throw new Error('psql not found. Install PostgreSQL client tools.')
      }
    }

    if (options.file) {
      // Run SQL file
      const args = [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        'admin',
        '-d',
        db,
        '-f',
        options.file,
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(psqlPath!, args, {
          stdio: 'inherit',
          env: { ...process.env, PGPASSWORD: 'quest' },
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`psql exited with code ${code}`))
          }
        })
      })
    } else if (options.sql) {
      // Run inline SQL
      const args = [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        'admin',
        '-d',
        db,
        '-c',
        options.sql,
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(psqlPath!, args, {
          stdio: 'inherit',
          env: { ...process.env, PGPASSWORD: 'quest' },
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`psql exited with code ${code}`))
          }
        })
      })
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }

  /**
   * Execute a SQL query and return structured results
   * Uses PostgreSQL wire protocol via psql
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container
    const db = options?.database || container.database || 'qdb'

    // Find psql
    let psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      const result = await findBinary('psql')
      if (result?.path) {
        psqlPath = result.path
      } else {
        throw new Error(
          'psql not found. Install PostgreSQL client tools or use the Web Console.',
        )
      }
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-X', // Skip ~/.psqlrc to ensure deterministic CSV output
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        'admin',
        '-d',
        db,
        '--csv',
        '-c',
        query,
      ]

      const proc = spawn(psqlPath!, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PGPASSWORD: 'quest' },
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
          reject(new Error(stderr || `psql exited with code ${code}`))
          return
        }

        try {
          resolve(parseCSVToQueryResult(stdout))
        } catch (error) {
          reject(
            new Error(
              `Failed to parse query result: ${error instanceof Error ? error.message : error}`,
            ),
          )
        }
      })
    })
  }
}

export const questdbEngine = new QuestDBEngine()
