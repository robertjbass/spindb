/**
 * SurrealDB Engine Implementation
 *
 * SurrealDB is a multi-model database that supports document, graph, and relational
 * data models with a powerful query language (SurrealQL).
 *
 * Key characteristics:
 * - Default HTTP port: 8000
 * - Single binary: `surreal` (handles server, sql client, export, import)
 * - Storage: SurrealKV (file-based) or RocksDB
 * - Default user: `root` (password set on startup)
 * - Hierarchy: Root > Namespace > Database
 * - Query language: SurrealQL (SQL-like with graph traversal)
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { surrealdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  SURREALDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  validateSurrealIdentifier,
  escapeSurrealIdentifier,
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

const ENGINE = 'surrealdb'
const engineDef = getEngineDefaults(ENGINE)

export class SurrealDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'SurrealDB'
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

  // Resolves version string to full version (e.g., '2' -> '2.3.2')
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return SURREALDB_VERSION_MAP[version] || version
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'surrealdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that SurrealDB binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const surrealPath = join(binPath, 'bin', `surreal${ext}`)
    return existsSync(surrealPath)
  }

  // Check if a specific SurrealDB version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return surrealdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure SurrealDB binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await surrealdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binary in config
    const ext = platformService.getExecutableExtension()
    const surrealPath = join(binPath, 'bin', `surreal${ext}`)
    if (existsSync(surrealPath)) {
      await configManager.setBinaryPath('surreal', surrealPath, 'bundled')
    }

    return binPath
  }

  /**
   * Initialize a new SurrealDB data directory
   * Creates the directory structure for SurrealDB's storage
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

    logDebug(`Created SurrealDB data directory: ${dataDir}`)

    return dataDir
  }

  // Get the path to surreal binary for a version
  async getSurrealPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'surrealdb',
      version: fullVersion,
      platform,
      arch,
    })
    const surrealPath = join(binPath, 'bin', `surreal${ext}`)

    if (existsSync(surrealPath)) {
      return surrealPath
    }

    throw new Error(
      `SurrealDB ${version} is not installed. Run: spindb engines download surrealdb ${version}`,
    )
  }

  /**
   * Start SurrealDB server
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

    // Get SurrealDB binary path
    let surrealBinary: string | null = null
    const ext = platformService.getExecutableExtension()

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(binaryPath, 'bin', `surreal${ext}`)
      if (existsSync(serverPath)) {
        surrealBinary = serverPath
        logDebug(`Using stored binary path: ${surrealBinary}`)
      }
    }

    if (!surrealBinary) {
      try {
        surrealBinary = await this.getSurrealPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `SurrealDB ${version} is not installed. Run: spindb engines download surrealdb ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = join(containerDir, 'surrealdb.log')
    const pidFile = join(containerDir, 'surrealdb.pid')

    onProgress?.({ stage: 'starting', message: 'Starting SurrealDB...' })

    logDebug(`Starting SurrealDB with data dir: ${dataDir}`)

    // SurrealDB start command
    // Using SurrealKV for file-based storage
    // Setting root credentials for authentication
    const args = [
      'start',
      `surrealkv://${dataDir}`,
      '--bind', `127.0.0.1:${port}`,
      '--user', 'root',
      '--pass', 'root',
      '--log', 'warn',
    ]

    // Spawn the server process
    // SurrealDB doesn't have a --background flag, so we detach it manually
    // Set cwd to container directory so history.txt goes there instead of user's cwd
    // Use 'ignore' for all stdio to prevent pipes from keeping the event loop alive
    const proc = spawn(surrealBinary!, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      cwd: containerDir,
      // On Windows, hide the console window to prevent it from blocking
      windowsHide: true,
    })

    // Wait for the process to spawn
    // On Windows, the 'spawn' event doesn't fire reliably with detached processes,
    // so we write the PID file immediately and use a fixed delay.
    // On Unix, we wait for the spawn event for more reliable startup detection.
    const isWindows = process.platform === 'win32'
    if (isWindows) {
      // Write PID file immediately on Windows
      if (proc.pid) {
        try {
          await writeFile(pidFile, proc.pid.toString(), 'utf-8')
          logDebug(`Windows: wrote PID file ${pidFile} (pid: ${proc.pid})`)
        } catch (err) {
          logDebug(`Failed to write PID file: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      proc.unref()
      logDebug(`Windows: waiting fixed delay for SurrealDB to start (pid: ${proc.pid})`)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    } else {
      const spawnTimeout = 30000
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`SurrealDB process failed to spawn within ${spawnTimeout}ms`))
        }, spawnTimeout)

        proc.on('error', (err) => {
          clearTimeout(timeoutId)
          logDebug(`SurrealDB spawn error: ${err.message}`)
          reject(new Error(`Failed to spawn SurrealDB: ${err.message}`))
        })

        // Capture early exit (process dies before spawn event)
        proc.on('close', (code, signal) => {
          clearTimeout(timeoutId)
          const errMsg = `SurrealDB process exited early (code: ${code}, signal: ${signal})`
          logDebug(errMsg)
          reject(new Error(errMsg))
        })

        proc.on('spawn', async () => {
          clearTimeout(timeoutId)
          logDebug(`SurrealDB process spawned (pid: ${proc.pid})`)

          // Remove the early exit handler since we spawned successfully
          proc.removeAllListeners('close')

          // Write PID file after successful spawn
          if (proc.pid) {
            try {
              await writeFile(pidFile, proc.pid.toString(), 'utf-8')
            } catch (err) {
              // PID file write failed - clean up and reject
              const errMsg = `Failed to write PID file: ${err instanceof Error ? err.message : String(err)}`
              logDebug(errMsg)

              // Kill the spawned process since we can't track it
              try {
                process.kill(proc.pid, 'SIGTERM')
              } catch {
                // Process may have already exited, ignore
              }

              // Remove partial PID file if it exists
              try {
                await unlink(pidFile)
              } catch {
                // Ignore cleanup errors (file may not exist)
              }

              reject(new Error(errMsg))
              return
            }
          }

          // Unref the process so it can run independently
          proc.unref()

          // Give the server a moment to initialize
          setTimeout(resolve, 500)
        })
      })
    }

    // Wait for server to be ready
    logDebug(`Waiting for SurrealDB server to be ready on port ${port}...`)
    const ready = await this.waitForReady(port, version)
    logDebug(`waitForReady returned: ${ready}`)

    if (!ready) {
      throw new Error(
        `SurrealDB failed to start within timeout. Check logs at: ${logFile}`,
      )
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // Wait for SurrealDB to be ready using surreal isready
  private async waitForReady(
    port: number,
    version: string,
    timeoutMs = 30000,
  ): Promise<boolean> {
    logDebug(`waitForReady called for port ${port}, version ${version}`)
    const startTime = Date.now()
    const checkInterval = 500

    let surreal: string
    try {
      logDebug('Getting surreal binary path...')
      surreal = await this.getSurrealPath(version)
      logDebug(`Got surreal binary path: ${surreal}`)
    } catch (err) {
      logDebug(`Error getting surreal binary path: ${err}`)
      logWarning(
        'SurrealDB binary not found, cannot verify server is ready.',
      )
      return false
    }

    logDebug(`Starting connection loop, timeout: ${timeoutMs}ms`)
    let attempt = 0
    const perAttemptTimeout = 5000 // 5 second timeout per isready attempt
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      logDebug(`Connection attempt ${attempt}...`)
      try {
        const args = [
          'isready',
          '--endpoint', `http://127.0.0.1:${port}`,
        ]
        await new Promise<void>((resolve, reject) => {
          let stderrOutput = ''
          const proc = spawn(surreal, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          })

          proc.stderr?.on('data', (data: Buffer) => {
            stderrOutput += data.toString()
          })

          // Timeout for this specific attempt - kill process if it hangs
          const attemptTimer = setTimeout(() => {
            logDebug(`isready attempt ${attempt} timed out after ${perAttemptTimeout}ms`)
            proc.kill('SIGKILL')
            reject(new Error('isready timeout'))
          }, perAttemptTimeout)

          proc.on('close', (code) => {
            clearTimeout(attemptTimer)
            logDebug(`isready process closed with code ${code}`)
            if (code === 0) resolve()
            else {
              // Log non-zero exit for debugging
              if (attempt <= 3 || attempt % 10 === 0) {
                logDebug(`isready attempt ${attempt} failed (code: ${code})${stderrOutput ? `: ${stderrOutput.trim()}` : ''}`)
              }
              reject(new Error(`Exit code ${code}`))
            }
          })
          proc.on('error', (err) => {
            clearTimeout(attemptTimer)
            logDebug(`isready error: ${err}`)
            reject(err)
          })
        })
        logDebug(`SurrealDB ready on port ${port}`)
        return true
      } catch (err) {
        logDebug(`Attempt ${attempt} failed: ${err}`)
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`SurrealDB did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop SurrealDB server
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'surrealdb.pid')

    logDebug(`Stopping SurrealDB container "${name}" on port ${port}`)

    // Find PID by checking the process using cross-platform helper
    let pid: number | null = null

    // Try to find SurrealDB process by port
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
      logDebug(`Killing SurrealDB process ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        // Wait for graceful termination
        // On Windows, SurrealDB's SurrealKV uses memory-mapped files that
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

    logDebug('SurrealDB stopped')
  }

  // Get SurrealDB server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { port, version } = container

    // Try to connect using surreal isready
    try {
      const surreal = await this.getSurrealPath(version)
      const args = [
        'isready',
        '--endpoint', `http://127.0.0.1:${port}`,
      ]
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(surreal, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Exit code ${code}`))
        })
        proc.on('error', reject)
      })
      return { running: true, message: 'SurrealDB is running' }
    } catch {
      return { running: false, message: 'SurrealDB is not running' }
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
    options: { database?: string } = {},
  ): Promise<RestoreResult> {
    const { name, port, version } = container

    return restoreBackup(backupPath, {
      containerName: name,
      port,
      database: options.database || container.database || 'default',
      version,
    })
  }

  /**
   * Get connection string
   * Format: ws://127.0.0.1:PORT or http://127.0.0.1:PORT
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    // SurrealDB WebSocket connection - namespace/database specified in queries
    return `ws://127.0.0.1:${port}/rpc`
  }

  // Open surreal sql interactive shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port, version, name } = container
    const db = database || container.database || 'default'
    const namespace = name.replace(/-/g, '_')

    const surreal = await this.getSurrealPath(version)

    // Use container directory as cwd so history.txt is written there, not user's cwd
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      cwd: containerDir,
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        surreal,
        [
          'sql',
          '--endpoint', `ws://127.0.0.1:${port}`,
          '--user', 'root',
          '--pass', 'root',
          '--ns', namespace,
          '--db', db,
          '--pretty',
        ],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * Create a new database
   * In SurrealDB, databases are created implicitly when accessed
   * But we can ensure it exists by defining it
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port, version, name } = container
    const namespace = name.replace(/-/g, '_')

    // Validate database identifier to prevent injection
    validateSurrealIdentifier(database, 'database')

    const surreal = await this.getSurrealPath(version)

    // Use container directory as cwd so history.txt is written there, not user's cwd
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    // SurrealDB creates databases implicitly, but we'll use USE to ensure it exists
    const args = [
      'sql',
      '--endpoint', `ws://127.0.0.1:${port}`,
      '--user', 'root',
      '--pass', 'root',
      '--ns', namespace,
      '--db', database,
      '--hide-welcome',
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(surreal, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: containerDir,
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      // Send a simple query to ensure namespace/database context is created
      proc.stdin?.write('INFO FOR DB;\n')
      proc.stdin?.end()

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Created SurrealDB database: ${database}`)
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
    const { port, version, name } = container
    const namespace = name.replace(/-/g, '_')

    // Don't allow dropping default database
    if (database === 'default') {
      throw new Error('Cannot drop the default database')
    }

    // Validate database identifier to prevent injection
    validateSurrealIdentifier(database, 'database')
    const escapedDb = escapeSurrealIdentifier(database)

    const surreal = await this.getSurrealPath(version)

    // Use container directory as cwd so history.txt is written there, not user's cwd
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    const args = [
      'sql',
      '--endpoint', `ws://127.0.0.1:${port}`,
      '--user', 'root',
      '--pass', 'root',
      '--ns', namespace,
      '--hide-welcome',
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(surreal, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: containerDir,
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      // Remove database
      proc.stdin?.write(`REMOVE DATABASE ${escapedDb};\n`)
      proc.stdin?.end()

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Dropped SurrealDB database: ${database}`)
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
   * SurrealDB doesn't have a direct size query, so we estimate from data directory
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const dataDir = paths.getContainerDataPath(container.name, { engine: ENGINE })

    try {
      const { stat, readdir } = await import('fs/promises')
      const stats = await stat(dataDir)

      if (!stats.isDirectory()) {
        return null
      }

      // Recursively calculate directory size
      let totalSize = 0
      const calculateSize = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            await calculateSize(fullPath)
          } else {
            const fileStat = await stat(fullPath)
            totalSize += fileStat.size
          }
        }
      }

      await calculateSize(dataDir)
      return totalSize
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote SurrealDB connection
   * Uses surreal export
   *
   * Connection string format: surrealdb://[user:password@]host[:port][/namespace/database]
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
      // Sanitize connection string to avoid leaking credentials in error messages
      const sanitized = connectionString.replace(
        /\/\/([^:]+):([^@]+)@/,
        '//***:***@',
      )
      throw new Error(
        `Invalid connection string: ${sanitized}\n` +
          'Expected format: surrealdb://[user:password@]host[:port][/namespace/database]',
      )
    }

    const host = url.hostname || '127.0.0.1'
    const port = parseInt(url.port, 10) || 8000
    const user = url.username || 'root'
    const password = url.password || 'root'

    // Parse namespace/database from path
    const pathParts = url.pathname.split('/').filter(Boolean)
    const namespace = pathParts[0] || 'test'
    const database = pathParts[1] || 'test'

    logDebug(`Connecting to remote SurrealDB at ${host}:${port} (ns: ${namespace}, db: ${database})`)

    // For remote dump, we need a local surreal binary
    let surreal: string | null = null
    const cached = await configManager.getBinaryPath('surreal')
    if (cached && existsSync(cached)) {
      surreal = cached
    }

    if (!surreal) {
      throw new Error(
        'SurrealDB binary not found. Run: spindb engines download surrealdb 2\n' +
          'A local SurrealDB binary is needed to dump from remote connections.',
      )
    }

    return new Promise<DumpResult>((resolve, reject) => {
      const args = [
        'export',
        '--endpoint', `http://${host}:${port}`,
        '--user', user,
        '--pass', password,
        '--ns', namespace,
        '--db', database,
        outputPath,
      ]

      const proc = spawn(surreal, args, {
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
          resolve({
            filePath: outputPath,
            stdout,
            stderr,
            code: 0,
          })
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

  // Run a SurrealQL file or inline statement
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port, version, name } = container
    const db = options.database || container.database || 'default'
    const namespace = name.replace(/-/g, '_')

    const surreal = await this.getSurrealPath(version)

    // Use container directory as cwd so history.txt is written there, not user's cwd
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })

    if (options.file) {
      // Run SurrealQL file using import
      const args = [
        'import',
        '--endpoint', `http://127.0.0.1:${port}`,
        '--user', 'root',
        '--pass', 'root',
        '--ns', namespace,
        '--db', db,
        options.file,
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(surreal, args, {
          stdio: 'inherit',
          cwd: containerDir,
        })

        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          if (code === 0) resolve()
          else if (code === null) reject(new Error(`surreal import was killed by signal ${signal}`))
          else reject(new Error(`surreal import exited with code ${code}`))
        })
      })
    } else if (options.sql) {
      // Run inline SurrealQL via stdin
      const args = [
        'sql',
        '--endpoint', `ws://127.0.0.1:${port}`,
        '--user', 'root',
        '--pass', 'root',
        '--ns', namespace,
        '--db', db,
        '--hide-welcome',
      ]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(surreal, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
          cwd: containerDir,
        })

        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          if (code === 0) resolve()
          else if (code === null) reject(new Error(`surreal sql was killed by signal ${signal}`))
          else reject(new Error(`surreal sql exited with code ${code}`))
        })

        proc.stdin?.write(options.sql)
        proc.stdin?.end()
      })
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }
}

export const surrealdbEngine = new SurrealDBEngine()
