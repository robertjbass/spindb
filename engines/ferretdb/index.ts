/**
 * FerretDB Engine implementation
 *
 * FerretDB is a MongoDB-compatible proxy that stores data in PostgreSQL.
 * This is a composite engine that manages two processes:
 * 1. PostgreSQL backend (postgresql-documentdb)
 * 2. FerretDB proxy
 *
 * The lifecycle is:
 * - Start: Start PostgreSQL → Wait for ready → Start FerretDB
 * - Stop: Stop FerretDB → Stop PostgreSQL
 */

import { spawn, exec, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import net from 'net'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join, basename } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { containerManager } from '../../core/container-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { spawnAsync } from '../../core/spawn-utils'
import { ferretdbBinaryManager } from './binary-manager'
import {
  SUPPORTED_MAJOR_VERSIONS,
  FALLBACK_VERSION_MAP,
  DEFAULT_DOCUMENTDB_VERSION,
  normalizeVersion,
  normalizeDocumentDBVersion,
} from './version-maps'
import { getBinaryUrls, isPlatformSupported } from './binary-urls'
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

const ENGINE = 'ferretdb'
const engineDef = getEngineDefaults(ENGINE)

// Default internal PostgreSQL port range for FerretDB backends
const BACKEND_PORT_START = 54320
const BACKEND_PORT_END = 54400

/**
 * Allocate a port for the PostgreSQL backend
 */
async function allocateBackendPort(): Promise<number> {
  for (let port = BACKEND_PORT_START; port < BACKEND_PORT_END; port++) {
    if (await isPortAvailable(port)) {
      return port
    }
  }
  throw new Error(
    `No available ports in range ${BACKEND_PORT_START}-${BACKEND_PORT_END} for PostgreSQL backend`,
  )
}

/**
 * Check if a port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Wait for a TCP port to accept connections
 */
function waitForPort(port: number, timeoutMs = 30000): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 500

  return new Promise((resolve) => {
    const check = () => {
      const socket = new net.Socket()
      socket.setTimeout(1000)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - startTime < timeoutMs) {
          setTimeout(check, checkInterval)
        } else {
          resolve(false)
        }
      })
      socket.once('timeout', () => {
        socket.destroy()
        if (Date.now() - startTime < timeoutMs) {
          setTimeout(check, checkInterval)
        } else {
          resolve(false)
        }
      })
      socket.connect(port, '127.0.0.1')
    }
    check()
  })
}

export class FerretDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'FerretDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // Get the current platform and architecture
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  /**
   * Check if the current platform supports FerretDB
   */
  isPlatformSupported(): boolean {
    const { platform, arch } = this.getPlatformInfo()
    return isPlatformSupported(platform, arch)
  }

  /**
   * Returns available FerretDB versions from the fallback version map.
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    const versions: Record<string, string[]> = {}

    for (const [major, full] of Object.entries(FALLBACK_VERSION_MAP)) {
      if (/^\d+$/.test(major)) {
        versions[major] = [full]
      }
    }

    return versions
  }

  // Get binary download URL from hostdb
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    const urls = getBinaryUrls(version, DEFAULT_DOCUMENTDB_VERSION, platform, arch)
    return urls.ferretdb
  }

  // Resolves version string to full version
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return FALLBACK_VERSION_MAP[version] || `${version}.0.0`
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return ferretdbBinaryManager.getFerretDBBinaryPath(fullVersion, p, a)
  }

  /**
   * Verify that FerretDB binaries are available and functional
   */
  async verifyBinary(binPath: string, version?: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()

    if (version) {
      return ferretdbBinaryManager.isInstalled(
        version,
        p,
        a,
        DEFAULT_DOCUMENTDB_VERSION,
      )
    }

    // Fallback: extract version from directory name
    const dirName = basename(binPath)
    const match = dirName.match(/^ferretdb-([\d.]+)-/)
    if (match) {
      const extractedVersion = match[1]
      return ferretdbBinaryManager.isInstalled(
        extractedVersion,
        p,
        a,
        DEFAULT_DOCUMENTDB_VERSION,
      )
    }

    // Last resort: check file existence
    const ext = platformService.getExecutableExtension()
    const ferretdbPath = join(binPath, 'bin', `ferretdb${ext}`)
    return existsSync(ferretdbPath)
  }

  // Check if a specific FerretDB version is installed
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return ferretdbBinaryManager.isInstalled(
      version,
      platform,
      arch,
      DEFAULT_DOCUMENTDB_VERSION,
    )
  }

  /**
   * Ensure FerretDB binaries are available for a specific version
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    // Download both binaries
    const { ferretdbPath } =
      await ferretdbBinaryManager.ensureInstalled(
        version,
        platform,
        arch,
        onProgress,
        DEFAULT_DOCUMENTDB_VERSION,
      )

    // Register ferretdb binary in config
    const ext = platformService.getExecutableExtension()
    const ferretdbBinary = join(ferretdbPath, 'bin', `ferretdb${ext}`)
    if (existsSync(ferretdbBinary)) {
      await configManager.setBinaryPath('ferretdb', ferretdbBinary, 'bundled')
    }

    return ferretdbPath
  }

  /**
   * Initialize a new FerretDB container directory
   * Creates both the PostgreSQL data directory and FerretDB config
   */
  async initDataDir(
    containerName: string,
    version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    // Get binary paths
    const backendVersion =
      (options.backendVersion as string) || DEFAULT_DOCUMENTDB_VERSION
    const fullBackendVersion = normalizeDocumentDBVersion(backendVersion)

    const documentdbPath = ferretdbBinaryManager.getDocumentDBBinaryPath(
      fullBackendVersion,
      platform,
      arch,
    )

    // Container directory structure
    const containerDir = paths.getContainerPath(containerName, { engine: ENGINE })
    const pgDataDir = join(containerDir, 'pg_data')
    const logsDir = join(containerDir, 'logs')

    // Create directories
    await mkdir(containerDir, { recursive: true })
    await mkdir(logsDir, { recursive: true })

    // Initialize PostgreSQL data directory
    // Check for PG_VERSION file to determine if already initialized
    // (directory may exist but be empty if created by containerManager.create)
    const pgVersionFile = join(pgDataDir, 'PG_VERSION')
    if (!existsSync(pgVersionFile)) {
      const ext = platformService.getExecutableExtension()
      const initdb = join(documentdbPath, 'bin', `initdb${ext}`)

      if (!existsSync(initdb)) {
        throw new Error(`initdb not found at ${initdb}`)
      }

      try {
        await spawnAsync(initdb, [
          '-D',
          pgDataDir,
          '-U',
          'postgres',
          '--encoding=UTF8',
          '--locale=C',
        ])
        logDebug(`Initialized PostgreSQL data directory: ${pgDataDir}`)
      } catch (error) {
        const err = error as Error
        throw new Error(`Failed to initialize PostgreSQL: ${err.message}`)
      }

      // Copy the bundled postgresql.conf.sample to ensure shared_preload_libraries is set
      // This is critical for DocumentDB extension to load properly
      const bundledConf = join(documentdbPath, 'share', 'postgresql.conf.sample')
      const pgConf = join(pgDataDir, 'postgresql.conf')

      if (existsSync(bundledConf)) {
        try {
          // Read the bundled config
          let confContent = await readFile(bundledConf, 'utf8')

          // Update cron.database_name to 'ferretdb' (required for pg_cron to work with DocumentDB)
          confContent = confContent.replace(
            /cron\.database_name\s*=\s*'[^']*'/,
            "cron.database_name = 'ferretdb'",
          )

          // Write the modified config
          await writeFile(pgConf, confContent)
          logDebug(`Copied and configured postgresql.conf to ${pgConf}`)
        } catch (copyError) {
          logDebug(`Warning: Could not copy postgresql.conf.sample: ${copyError}`)
          // Continue anyway - initdb creates a default config
        }
      } else {
        logDebug(`Bundled postgresql.conf.sample not found at ${bundledConf}`)
      }
    }

    return pgDataDir
  }

  /**
   * Start FerretDB (two-process lifecycle)
   *
   * 1. Allocate/verify backend port
   * 2. Start PostgreSQL
   * 3. Wait for PostgreSQL ready
   * 4. Create ferretdb database + extension (first start)
   * 5. Start FerretDB proxy
   * 6. Verify FerretDB connectivity
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version, backendVersion, backendPort: existingBackendPort } = container

    // Check if already running
    const alreadyRunning = await processManager.isRunning(name, { engine: ENGINE })
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const fullBackendVersion = normalizeDocumentDBVersion(
      backendVersion || DEFAULT_DOCUMENTDB_VERSION,
    )

    // Get binary paths
    const ferretdbPath = ferretdbBinaryManager.getFerretDBBinaryPath(
      fullVersion,
      platform,
      arch,
    )
    const documentdbPath = ferretdbBinaryManager.getDocumentDBBinaryPath(
      fullBackendVersion,
      platform,
      arch,
    )

    const ext = platformService.getExecutableExtension()
    const ferretdbBinary = join(ferretdbPath, 'bin', `ferretdb${ext}`)
    const pgCtl = join(documentdbPath, 'bin', `pg_ctl${ext}`)
    const psql = join(documentdbPath, 'bin', `psql${ext}`)

    // Verify binaries exist
    if (!existsSync(ferretdbBinary)) {
      throw new Error(
        `FerretDB binary not found. Run: spindb engines download ferretdb ${version}`,
      )
    }
    if (!existsSync(pgCtl)) {
      throw new Error(
        `postgresql-documentdb not found. Run: spindb engines download ferretdb ${version}`,
      )
    }

    // Container paths
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pgDataDir = join(containerDir, 'pg_data')
    const logsDir = join(containerDir, 'logs')
    const pgLogFile = join(logsDir, 'postgres.log')
    const ferretPidFile = join(containerDir, 'ferretdb.pid')

    // Allocate backend port
    const backendPort = existingBackendPort || await allocateBackendPort()

    let pgStarted = false
    let ferretStarted = false

    try {
      // 1. Start PostgreSQL
      onProgress?.({ stage: 'starting', message: 'Starting PostgreSQL backend...' })

      // Use pg_ctl to start PostgreSQL
      await spawnAsync(pgCtl, [
        'start',
        '-D',
        pgDataDir,
        '-l',
        pgLogFile,
        '-o',
        `-p ${backendPort} -h 127.0.0.1`,
        '-w', // Wait for startup
      ])

      pgStarted = true
      logDebug(`PostgreSQL started on port ${backendPort}`)

      // 2. Wait for PostgreSQL to be ready
      onProgress?.({ stage: 'starting', message: 'Waiting for PostgreSQL...' })
      const pgReady = await waitForPort(backendPort, 30000)
      if (!pgReady) {
        throw new Error('PostgreSQL failed to start within timeout')
      }

      // 3. Create ferretdb database and extension (first start)
      onProgress?.({ stage: 'starting', message: 'Initializing FerretDB database...' })
      try {
        // Create ferretdb database if it doesn't exist
        await spawnAsync(psql, [
          '-h',
          '127.0.0.1',
          '-p',
          String(backendPort),
          '-U',
          'postgres',
          '-c',
          "SELECT 1 FROM pg_database WHERE datname='ferretdb'" +
            " OR (SELECT count(*) FROM pg_database WHERE datname='ferretdb') = 0" +
            " AND pg_catalog.pg_create_database('ferretdb', template := 'template0', encoding := 'UTF8') IS NOT NULL;",
        ]).catch(async () => {
          // Database might already exist, try creating it directly
          await spawnAsync(psql, [
            '-h',
            '127.0.0.1',
            '-p',
            String(backendPort),
            '-U',
            'postgres',
            '-c',
            "CREATE DATABASE ferretdb WITH ENCODING 'UTF8';",
          ]).catch(() => {
            // Ignore error if database already exists
          })
        })

        // Create DocumentDB extension
        await spawnAsync(psql, [
          '-h',
          '127.0.0.1',
          '-p',
          String(backendPort),
          '-U',
          'postgres',
          '-d',
          'ferretdb',
          '-c',
          'CREATE EXTENSION IF NOT EXISTS documentdb CASCADE;',
        ]).catch((error) => {
          logWarning(`Failed to create documentdb extension: ${error}`)
          // Continue anyway - extension might already exist
        })

        logDebug('FerretDB database initialized')
      } catch (error) {
        logDebug(`Database initialization warning: ${error}`)
        // Continue - might already be initialized
      }

      // 4. Start FerretDB proxy
      onProgress?.({ stage: 'starting', message: 'Starting FerretDB proxy...' })

      const ferretArgs = [
        '--listen-addr',
        `127.0.0.1:${port}`,
        '--postgresql-url',
        `postgres://postgres@127.0.0.1:${backendPort}/ferretdb`,
        '--state-dir',
        containerDir,
      ]

      logDebug(`Starting FerretDB with args: ${ferretArgs.join(' ')}`)

      const spawnOpts: SpawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      }

      const proc = spawn(ferretdbBinary, ferretArgs, spawnOpts)

      // Log output
      let stderrOutput = ''
      proc.stdout?.on('data', (data: Buffer) => {
        logDebug(`ferretdb stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString()
        logDebug(`ferretdb stderr: ${data.toString()}`)
      })

      proc.unref()

      // Write PID file
      if (proc.pid) {
        await writeFile(ferretPidFile, String(proc.pid))
        ferretStarted = true
      }

      // 5. Wait for FerretDB to be ready
      const ferretReady = await waitForPort(port, 30000)
      if (!ferretReady) {
        throw new Error(
          `FerretDB failed to start within timeout. Stderr: ${stderrOutput}`,
        )
      }

      logDebug(`FerretDB started on port ${port}`)

      // Persist the allocated backend port if it was newly allocated
      if (!existingBackendPort && backendPort) {
        await containerManager.updateConfig(name, { backendPort })
        logDebug(`Persisted backend port ${backendPort} to container config`)
      }

      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    } catch (error) {
      // Rollback: stop any started processes
      if (ferretStarted) {
        await this.stopFerretDBProcess(containerDir).catch(() => {})
      }
      if (pgStarted) {
        await this.stopPostgreSQLProcess(pgCtl, pgDataDir).catch(() => {})
      }
      throw error
    }
  }

  /**
   * Stop FerretDB (reverse order: FerretDB first, then PostgreSQL)
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, backendVersion } = container
    const { platform, arch } = this.getPlatformInfo()

    const fullBackendVersion = normalizeDocumentDBVersion(
      backendVersion || DEFAULT_DOCUMENTDB_VERSION,
    )

    const documentdbPath = ferretdbBinaryManager.getDocumentDBBinaryPath(
      fullBackendVersion,
      platform,
      arch,
    )
    const ext = platformService.getExecutableExtension()
    const pgCtl = join(documentdbPath, 'bin', `pg_ctl${ext}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pgDataDir = join(containerDir, 'pg_data')

    logDebug(`Stopping FerretDB container "${name}"`)

    // 1. Stop FerretDB proxy
    await this.stopFerretDBProcess(containerDir)

    // 2. Stop PostgreSQL
    if (existsSync(pgCtl)) {
      await this.stopPostgreSQLProcess(pgCtl, pgDataDir)
    }

    logDebug('FerretDB stopped')
  }

  /**
   * Stop FerretDB proxy process
   */
  private async stopFerretDBProcess(containerDir: string): Promise<void> {
    const pidFile = join(containerDir, 'ferretdb.pid')

    if (existsSync(pidFile)) {
      try {
        const pidContent = await readFile(pidFile, 'utf8')
        const pid = parseInt(pidContent.trim(), 10)

        if (!isNaN(pid) && platformService.isProcessRunning(pid)) {
          logDebug(`Killing FerretDB process ${pid}`)
          await platformService.terminateProcess(pid, false)
          await new Promise((resolve) => setTimeout(resolve, 2000))

          if (platformService.isProcessRunning(pid)) {
            logWarning(`Graceful termination failed, force killing ${pid}`)
            await platformService.terminateProcess(pid, true)
          }
        }

        await unlink(pidFile).catch(() => {})
      } catch (error) {
        logDebug(`Error stopping FerretDB: ${error}`)
      }
    }
  }

  /**
   * Stop PostgreSQL process
   */
  private async stopPostgreSQLProcess(
    pgCtl: string,
    pgDataDir: string,
  ): Promise<void> {
    try {
      await spawnAsync(pgCtl, ['stop', '-D', pgDataDir, '-m', 'fast', '-w'])
      logDebug('PostgreSQL stopped')
    } catch (error) {
      logDebug(`pg_ctl stop error: ${error}`)
      // Try immediate mode if fast fails
      try {
        await spawnAsync(pgCtl, ['stop', '-D', pgDataDir, '-m', 'immediate', '-w'])
      } catch {
        logWarning('Failed to stop PostgreSQL gracefully')
      }
    }
  }

  // Get FerretDB server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'ferretdb.pid')

    // Check if FerretDB is responding
    const isOpen = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(1000)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.connect(port, '127.0.0.1')
    })

    if (isOpen) {
      return { running: true, message: 'FerretDB is running' }
    }

    // Check PID file
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
          return {
            running: true,
            message: `FerretDB is running (PID: ${pid})`,
          }
        }
      } catch {
        // Ignore
      }
    }

    return { running: false, message: 'FerretDB is not running' }
  }

  // Detect backup format
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  // Restore a backup
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: Record<string, unknown> = {},
  ): Promise<RestoreResult> {
    const { backendPort } = container
    const database = (options.database as string) || 'ferretdb'

    if (!backendPort) {
      throw new Error('Backend port not set - start the container first')
    }

    return restoreBackup(container, backupPath, {
      database,
      drop: options.drop !== false,
    })
  }

  // Get connection string (MongoDB-compatible)
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'test'
    return `mongodb://127.0.0.1:${port}/${db}`
  }

  // Get PostgreSQL backend connection string (for debugging)
  getBackendConnectionString(container: ContainerConfig): string {
    const { backendPort } = container
    return `postgresql://postgres@127.0.0.1:${backendPort || 54320}/ferretdb`
  }

  /**
   * Get the path to mongosh (uses MongoDB's mongosh)
   * FerretDB is MongoDB-compatible, so it uses the same shell
   */
  override async getMongoshPath(): Promise<string> {
    const cached = await configManager.getBinaryPath('mongosh')
    if (cached && existsSync(cached)) return cached

    // Try to find in PATH as fallback
    const detected = await platformService.findToolPath('mongosh')
    if (detected) {
      await configManager.setBinaryPath('mongosh', detected, 'system')
      return detected
    }

    throw new Error(
      'mongosh not found. To connect to FerretDB, install mongosh:\n' +
        '  Download from: https://www.mongodb.com/try/download/shell\n' +
        '  Or download MongoDB binaries: spindb engines download mongodb <version>',
    )
  }

  // Open mongosh interactive shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || 'test'

    const mongosh = await this.getMongoshPath()

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        mongosh,
        ['--host', '127.0.0.1', '--port', String(port), db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * Create a new database
   * FerretDB/MongoDB creates databases implicitly when you write to them
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    // MongoDB/FerretDB creates databases implicitly
    // Just verify the connection works
    logDebug(`Database "${database}" will be created when first accessed`)
  }

  // Drop a database
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    try {
      const mongosh = await this.getMongoshPath()
      const cmd = isWindows()
        ? `"${mongosh}" --host 127.0.0.1 --port ${port} ${database} --eval "db.dropDatabase()"`
        : `"${mongosh}" --host 127.0.0.1 --port ${port} ${database} --eval 'db.dropDatabase()'`

      await execAsync(cmd, { timeout: 10000 })
    } catch (error) {
      logDebug(`dropDatabase result: ${error}`)
    }
  }

  // Get the size of the database in bytes
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, database } = container
    const db = database || 'test'

    try {
      const mongosh = await this.getMongoshPath()
      const script = 'JSON.stringify(db.stats())'
      const cmd = isWindows()
        ? `"${mongosh}" --host 127.0.0.1 --port ${port} ${db} --quiet --eval "${script}"`
        : `"${mongosh}" --host 127.0.0.1 --port ${port} ${db} --quiet --eval '${script}'`

      const { stdout } = await execAsync(cmd, { timeout: 10000 })

      // Extract JSON from output
      const firstBrace = stdout.indexOf('{')
      const lastBrace = stdout.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const stats = JSON.parse(stdout.substring(firstBrace, lastBrace + 1))
        return stats?.dataSize || null
      }
      return null
    } catch {
      return null
    }
  }

  // Create a dump from a remote database
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // Use mongodump if available
    const mongodump = await configManager.getBinaryPath('mongodump')
    if (!mongodump) {
      throw new Error(
        'mongodump not found. Download MongoDB binaries:\n' +
          '  Run: spindb engines download mongodb <version>',
      )
    }

    const args = ['--uri', connectionString, '--archive=' + outputPath, '--gzip']

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(mongodump, args, spawnOptions)

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
          resolve({
            filePath: outputPath,
            stdout,
            stderr,
            code,
          })
        } else {
          reject(new Error(stderr || `mongodump exited with code ${code}`))
        }
      })
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

  // Run a JavaScript file or inline script against the database
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container
    const db = options.database || container.database || 'test'

    const mongosh = await this.getMongoshPath()

    if (options.file) {
      const spawnOptions: SpawnOptions = {
        stdio: 'inherit',
      }

      return new Promise((resolve, reject) => {
        const proc = spawn(
          mongosh,
          [
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            db,
            '--file',
            options.file!,
          ],
          spawnOptions,
        )

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`mongosh exited with code ${code}`))
          }
        })
      })
    } else if (options.sql) {
      // sql field is actually JS for MongoDB-compatible databases
      const script = options.sql
      const cmd = isWindows()
        ? `"${mongosh}" --host 127.0.0.1 --port ${port} ${db} --eval "${script.replace(/"/g, '\\"')}"`
        : `"${mongosh}" --host 127.0.0.1 --port ${port} ${db} --eval '${script.replace(/'/g, "'\\''")}' `

      const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 })
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }
}

export const ferretdbEngine = new FerretDBEngine()
