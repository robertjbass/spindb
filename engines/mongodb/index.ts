/**
 * MongoDB Engine implementation
 * Manages MongoDB database containers using hostdb-downloaded binaries
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
import {
  logDebug,
  logWarning,
  assertValidDatabaseName,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { mongodbBinaryManager } from './binary-manager'
import { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'
import { getBinaryUrl } from './binary-urls'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
  parseConnectionString,
} from './restore'
import { createBackup } from './backup'
import { getMongodumpPath, MONGODUMP_NOT_FOUND_ERROR } from './cli-utils'
import {
  Platform,
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
import { parseMongoDBResult } from '../../core/query-parser'

const execAsync = promisify(exec)

const ENGINE = 'mongodb'
const engineDef = getEngineDefaults(ENGINE)

// Build a mongosh command for inline JavaScript execution
export function buildMongoshCommand(
  mongoshPath: string,
  port: number,
  database: string,
  script: string,
  options?: { quiet?: boolean },
): string {
  const quietFlag = options?.quiet ? ' --quiet' : ''
  if (isWindows()) {
    // Windows: use double quotes
    const escaped = script.replace(/"/g, '\\"')
    return `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database}${quietFlag} --eval "${escaped}"`
  } else {
    // Unix: use single quotes
    const escaped = script.replace(/'/g, "'\\''")
    return `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database}${quietFlag} --eval '${escaped}'`
  }
}

/**
 * Extract JSON from mongosh output that may contain extra messages/prompts
 * Returns the parsed JSON or null if extraction fails
 */
function extractJson(output: string): unknown | null {
  const trimmed = output.trim()

  // Find the first '{' and last '}' to extract JSON object
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null
  }

  try {
    return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1))
  } catch {
    return null
  }
}

export class MongoDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'MongoDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // Get the current platform and architecture
  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  /**
   * Returns available MongoDB versions from the fallback version map.
   *
   * Note: This returns cached/fallback data from FALLBACK_VERSION_MAP and does not
   * perform network I/O. This matches the behavior of other engines that maintain
   * a static version map synchronized with hostdb releases.json.
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    const versions: Record<string, string[]> = {}

    for (const [majorMinor, full] of Object.entries(FALLBACK_VERSION_MAP)) {
      versions[majorMinor] = [full]
    }

    return versions
  }

  // Get binary download URL from hostdb
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  // Resolves version string to full version (e.g., '8' -> '8.0.17')
  resolveFullVersion(version: string): string {
    // Check if already a full version (has at least two dots)
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // It's a major or major.minor version, resolve using fallback map
    return FALLBACK_VERSION_MAP[version] || `${version}.0.0`
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'mongodb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  /**
   * Verify that MongoDB binaries are available and functional
   *
   * Delegates to mongodbBinaryManager.verify() which:
   * 1. Checks file existence
   * 2. Executes `mongod --version`
   * 3. Validates version output matches expected version
   *
   * @param binPath - Path to MongoDB binary directory (e.g., ~/.spindb/bin/mongodb-8.0.17-darwin-arm64)
   * @param version - Optional explicit version to verify against
   */
  async verifyBinary(binPath: string, version?: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()

    // Use explicit version if provided
    if (version) {
      return mongodbBinaryManager.verify(version, p, a)
    }

    // Fallback: extract version from directory name (format: mongodb-{version}-{platform}-{arch})
    // Use basename to avoid issues with dashes in parent directory names
    const dirName = basename(binPath)
    const match = dirName.match(/^mongodb-([\d.]+)-/)
    if (match) {
      const extractedVersion = match[1]
      return mongodbBinaryManager.verify(extractedVersion, p, a)
    }

    // Last resort: just check file existence
    const ext = platformService.getExecutableExtension()
    const mongodPath = join(binPath, 'bin', `mongod${ext}`)
    return existsSync(mongodPath)
  }

  // Check if a specific MongoDB version is installed
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return mongodbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure MongoDB binaries are available for a specific version
   * Downloads from hostdb for all platforms
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    // Download from hostdb
    const binPath = await mongodbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binaries in config (includes server + client tools)
    const ext = platformService.getExecutableExtension()
    const bundledTools = [
      'mongod', // server
      'mongosh', // shell client
      'mongodump', // backup utility
      'mongorestore', // restore utility
    ] as const

    for (const tool of bundledTools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * Initialize a new MongoDB data directory
   * Unlike MySQL, MongoDB doesn't require initialization - just create the directory
   */
  async initDataDir(
    containerName: string,
    _version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    // Create data directory if it doesn't exist
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created MongoDB data directory: ${dataDir}`)
    }

    return dataDir
  }

  /**
   * Start MongoDB server
   * CLI wrapper: mongod --dbpath {dir} --port {port} --bind_ip 127.0.0.1
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
    let mongod: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      // binaryPath is the directory (e.g., ~/.spindb/bin/mongodb-8.0.17-linux-arm64)
      // We need to construct the full path to mongod
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `mongod${ext}`)
      if (existsSync(serverPath)) {
        mongod = serverPath
        logDebug(`Using stored binary path: ${mongod}`)
      }
    }

    // If we didn't find the binary above, fall back to normal path
    if (!mongod) {
      // Get mongod from config or download if needed
      const mongodPath = await configManager.getBinaryPath('mongod')
      if (mongodPath && existsSync(mongodPath)) {
        mongod = mongodPath
        logDebug(`Using registered binary path: ${mongod}`)
      } else {
        // Try to ensure binaries are available
        const binPath = await this.ensureBinaries(version, onProgress)
        const ext = platformService.getExecutableExtension()
        mongod = join(binPath, 'bin', `mongod${ext}`)

        if (!existsSync(mongod)) {
          throw new Error(
            `MongoDB ${version} is not installed. ` +
              `Run: spindb engines download mongodb ${version}`,
          )
        }
      }
    }

    logDebug(`Using mongod for version ${version}: ${mongod}`)

    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'mongod.pid')

    onProgress?.({ stage: 'starting', message: 'Starting MongoDB...' })

    const args = [
      '--dbpath',
      dataDir,
      '--port',
      String(port),
      '--bind_ip',
      '127.0.0.1',
      '--logpath',
      logFile,
      '--logappend',
    ]

    // Note: --fork is not supported on macOS (Sonoma+), so we use detached spawn
    // for both macOS and Windows. Only Linux still supports --fork.
    const { platform } = platformService.getPlatformInfo()
    const useDetachedSpawn =
      platform === Platform.Win32 || platform === Platform.Darwin

    if (!useDetachedSpawn) {
      // Linux: can use --fork for native daemonization
      args.push('--fork')
    }

    logDebug(`Starting mongod with args: ${args.join(' ')}`)

    if (useDetachedSpawn) {
      // macOS/Windows: spawn detached process
      const spawnOpts: SpawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      }
      if (isWindows()) {
        spawnOpts.windowsHide = true
      }

      const proc = spawn(mongod, args, spawnOpts)

      proc.stdout?.on('data', (data: Buffer) => {
        logDebug(`mongod stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        logDebug(`mongod stderr: ${data.toString()}`)
      })

      proc.unref()

      // Write PID file
      if (proc.pid) {
        await writeFile(pidFile, String(proc.pid))
      }
    } else {
      // Linux: mongod --fork handles daemonization itself
      return new Promise((resolve, reject) => {
        const proc = spawn(mongod, args, {
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

        proc.on('close', async (code) => {
          if (code === 0) {
            // MongoDB forked successfully, now wait for it to be ready
            const ready = await this.waitForReady(port)
            if (ready) {
              // Read PID from lock file
              const lockFile = join(dataDir, 'mongod.lock')
              try {
                const pid = await readFile(lockFile, 'utf8')
                await writeFile(pidFile, pid.trim())
              } catch {
                // Lock file might not exist yet
              }
              resolve({
                port,
                connectionString: this.getConnectionString(container),
              })
            } else {
              reject(new Error('MongoDB failed to start within timeout'))
            }
          } else {
            reject(
              new Error(stderr || stdout || `mongod exited with code ${code}`),
            )
          }
        })

        proc.on('error', reject)
      })
    }

    // Wait for MongoDB to be ready (Windows path)
    const ready = await this.waitForReady(port)
    if (!ready) {
      throw new Error('MongoDB failed to start within timeout')
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // Check if a TCP port is accepting connections
  private checkPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
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
  }

  /**
   * Wait for MongoDB to be ready to accept connections
   *
   * Uses two strategies depending on tool availability:
   * 1. **Preferred (mongosh available)**: Executes `db.runCommand({ping:1})` via mongosh
   *    to verify MongoDB is fully operational and responding to commands.
   * 2. **Fallback (mongosh unavailable)**: Uses TCP port check via checkPortOpen().
   *    TCP connectivity is a less thorough check than a mongosh ping - it only confirms
   *    the port is accepting connections, not that MongoDB is fully initialized and
   *    ready to process queries. However, for local development containers this is
   *    acceptable since MongoDB typically accepts connections shortly after becoming
   *    ready, and this avoids requiring mongosh to be installed.
   */
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    const mongosh = await configManager.getBinaryPath('mongosh')
    if (!mongosh) {
      // Fallback: TCP port check when mongosh is unavailable
      // Less thorough than db.runCommand({ping:1}) but sufficient for local dev containers
      logDebug(
        `mongosh not found, using TCP port check for MongoDB on port ${port}`,
      )
      while (Date.now() - startTime < timeoutMs) {
        const isOpen = await this.checkPortOpen(port)
        if (isOpen) return true
        await new Promise((r) => setTimeout(r, checkInterval))
      }
      return false
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        const cmd = buildMongoshCommand(
          mongosh,
          port,
          'admin',
          'db.runCommand({ping:1})',
          { quiet: true },
        )
        await execAsync(cmd, { timeout: 5000 })
        return true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    return false
  }

  /**
   * Stop MongoDB server
   * Uses db.adminCommand({shutdown:1}) via mongosh or SIGTERM
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'mongod.pid')
    const lockFile = join(dataDir, 'mongod.lock')

    logDebug(`Stopping MongoDB container "${name}" on port ${port}`)

    // Try graceful shutdown via mongosh
    const mongosh = await configManager.getBinaryPath('mongosh')
    if (mongosh) {
      try {
        const cmd = buildMongoshCommand(
          mongosh,
          port,
          'admin',
          'db.adminCommand({shutdown:1})',
        )
        await execAsync(cmd, { timeout: 10000 })
        logDebug('MongoDB shutdown command sent')
        // Wait a bit for process to exit
        await new Promise((resolve) => setTimeout(resolve, 2000))
      } catch (error) {
        logDebug(`mongosh shutdown failed: ${error}`)
        // Continue to PID-based shutdown
      }
    }

    // Get PID and force kill if needed
    let pid: number | null = null

    // Try PID file first
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // Ignore
      }
    }

    // Try lock file if no PID from pid file
    if (!pid && existsSync(lockFile)) {
      try {
        const content = await readFile(lockFile, 'utf8')
        const parsed = parseInt(content.trim(), 10)
        if (!isNaN(parsed) && parsed > 0) {
          pid = parsed
        }
      } catch {
        // Ignore
      }
    }

    // Kill process if still running
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing MongoDB process ${pid}`)
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

    logDebug('MongoDB stopped')
  }

  // Get MongoDB server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'mongod.pid')
    const lockFile = join(dataDir, 'mongod.lock')

    // Try pinging with mongosh
    const mongosh = await configManager.getBinaryPath('mongosh')
    if (mongosh) {
      try {
        const cmd = buildMongoshCommand(
          mongosh,
          port,
          'admin',
          'db.runCommand({ping:1})',
          { quiet: true },
        )
        await execAsync(cmd, { timeout: 5000 })
        return { running: true, message: 'MongoDB is running' }
      } catch {
        // Not responding, check PID
      }
    }

    // Check PID file
    for (const file of [pidFile, lockFile]) {
      if (existsSync(file)) {
        try {
          const content = await readFile(file, 'utf8')
          const pid = parseInt(content.trim(), 10)
          if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
            return {
              running: true,
              message: `MongoDB is running (PID: ${pid})`,
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    return { running: false, message: 'MongoDB is not running' }
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
    const { port, version } = container
    const database = (options.database as string) || container.database

    return restoreBackup(backupPath, {
      port,
      database,
      drop: options.drop !== false,
      validateVersion: options.validateVersion !== false,
      containerVersion: version,
    })
  }

  // Get connection string
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'test'
    return `mongodb://127.0.0.1:${port}/${db}`
  }

  // Get path to mongosh
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
      'mongosh not found. Download MongoDB binaries:\n' +
        '  Run: spindb engines download mongodb <version>\n' +
        '  Or install mongosh from: https://www.mongodb.com/try/download/shell',
    )
  }

  // Open mongosh interactive shell
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || container.database || 'test'

    const mongosh = await this.getMongoshPath()

    // Note: Don't use shell mode - spawn handles paths with spaces correctly
    // when shell: false (the default). Shell mode breaks paths like "C:\Program Files\..."
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
   * MongoDB creates databases implicitly when you first write to them.
   * To force immediate creation, we create a temporary collection and drop it.
   * This leaves the database visible in tools without any marker clutter.
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container

    const mongosh = await this.getMongoshPath()

    // MongoDB creates databases implicitly when you write to them.
    // Create a temp collection then immediately drop it to force database creation
    // without leaving any visible marker collections.
    // First drop any existing _spindb_init collection (ignore errors), then create and drop.
    // This ensures cleanup even if a previous createDatabase was interrupted.
    // NOTE: Use db.getCollection() instead of db._spindb_init shorthand because
    // mongosh doesn't support shorthand notation for collection names starting with underscore.
    const cmd = buildMongoshCommand(
      mongosh,
      port,
      database,
      'try { db.getCollection("_spindb_init").drop(); } catch(e) {} db.createCollection("_spindb_init"); db.getCollection("_spindb_init").drop();',
    )

    await execAsync(cmd, { timeout: 10000 })
  }

  // Drop a database
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container

    const mongosh = await this.getMongoshPath()

    const cmd = buildMongoshCommand(
      mongosh,
      port,
      database,
      'db.dropDatabase()',
    )

    try {
      await execAsync(cmd, { timeout: 10000 })
    } catch (error) {
      const err = error as Error
      // Ignore "database doesn't exist" scenarios
      logDebug(`dropDatabase result: ${err.message}`)
    }
  }

  // Get the size of the database in bytes
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, database } = container
    const db = database || 'test'

    try {
      const mongosh = await this.getMongoshPath()
      const cmd = buildMongoshCommand(
        mongosh,
        port,
        db,
        'JSON.stringify(db.stats())',
        { quiet: true },
      )

      const { stdout } = await execAsync(cmd, { timeout: 10000 })

      // Defensively extract JSON from output (may contain extra messages)
      const stats = extractJson(stdout) as { dataSize?: number } | null
      return stats?.dataSize || null
    } catch {
      return null
    }
  }

  // Create a dump from a remote database
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const mongodump = await getMongodumpPath()
    if (!mongodump) {
      throw new Error(MONGODUMP_NOT_FOUND_ERROR)
    }

    const parsed = parseConnectionString(connectionString)

    // Always use --uri to avoid exposing credentials as separate CLI arguments
    // The URI keeps credentials embedded (still visible in process listings,
    // but this is MongoDB's recommended approach and handles all edge cases)
    const args = [
      '--uri',
      connectionString,
      '--db',
      parsed.database,
      '--archive=' + outputPath,
      '--gzip',
    ]

    // Note: Don't use shell mode - spawn handles paths with spaces correctly
    // when shell: false (the default). Shell mode breaks paths like "C:\Program Files\..."
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
      // Run script file
      // Note: Don't use shell mode here - spawn handles paths with spaces correctly
      // when shell: false (the default). Shell mode would require quoting the path.
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
      // Run inline script (using sql field for compatibility, but it's actually JS)
      const cmd = buildMongoshCommand(mongosh, port, db, options.sql)
      const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 })
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }

  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container
    const db = options?.database || container.database || 'test'

    const mongosh = await this.getMongoshPath()

    // Reject "use " shell helper - it doesn't work with JSON output
    const trimmedQuery = query.trim()
    if (trimmedQuery.toLowerCase().startsWith('use ')) {
      throw new Error(
        'The "use" command is not supported in executeQuery. ' +
          'To switch databases, set options.database or container.database instead.',
      )
    }

    // Auto-prepend db. if not already present for collection methods
    // But don't prepend for shell helper functions
    let script = trimmedQuery
    const shellFunctions = [
      'print',
      'printjson',
      'sleep',
      'ObjectId',
      'ISODate',
      'NumberLong',
      'NumberInt',
      'NumberDecimal',
      'UUID',
      'BinData',
      'Timestamp',
      'MinKey',
      'MaxKey',
    ]
    const startsWithShellFunction = shellFunctions.some(
      (fn) => script.startsWith(`${fn}(`) || script.startsWith(`${fn} (`),
    )
    if (!script.startsWith('db.') && !startsWithShellFunction) {
      script = `db.${script}`
    }

    // Wrap in JSON.stringify for parseable output
    // Handle both toArray() results and single document results
    const wrappedScript = `JSON.stringify(${script})`

    const cmd = buildMongoshCommand(mongosh, port, db, wrappedScript, {
      quiet: true,
    })

    const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 })

    if (stderr && !stdout.trim()) {
      throw new Error(`${stderr}${stdout ? `\nOutput: ${stdout}` : ''}`)
    }

    // Extract JSON from output (mongosh may include extra output)
    const jsonMatch = stdout.match(/\[[\s\S]*\]|\{[\s\S]*\}/)
    if (!jsonMatch) {
      // Handle scalar results
      return {
        columns: ['result'],
        rows: [{ result: stdout.trim() }],
        rowCount: 1,
      }
    }

    return parseMongoDBResult(jsonMatch[0])
  }

  /**
   * List all user databases, excluding system databases (admin, config, local).
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { port } = container
    const mongosh = await this.getMongoshPath()

    return new Promise((resolve, reject) => {
      // Use JSON output for reliable parsing
      const script = `JSON.stringify(db.adminCommand({listDatabases: 1}).databases.map(d => d.name))`
      const args = ['--quiet', '--host', `127.0.0.1:${port}`, '--eval', script]

      const proc = spawn(mongosh, args, {
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
          reject(new Error(stderr || `mongosh exited with code ${code}`))
          return
        }

        try {
          const allDatabases = JSON.parse(stdout.trim()) as string[]
          const systemDatabases = ['admin', 'config', 'local']
          const databases = allDatabases.filter(
            (db) => !systemDatabases.includes(db),
          )
          resolve(databases)
        } catch (error) {
          reject(new Error(`Failed to parse database list: ${error}`))
        }
      })
    })
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password, database } = options
    assertValidUsername(username)
    const { port } = container
    const db = database || container.database || 'admin'
    assertValidDatabaseName(db)
    const mongosh = await this.getMongoshPath()

    // Create user with readWrite role on the target database
    // Auth is not enforced (no --auth flag) but user is still created
    // Use JSON.stringify for password to safely escape all special characters in JS context
    // Pass script via stdin to avoid exposing passwords in process listings
    const jsonPwd = JSON.stringify(password)
    const script = `db.getSiblingDB('${db}').createUser({user:'${username}',pwd:${jsonPwd},roles:[{role:'readWrite',db:'${db}'}]})`

    const mongoshArgs = [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      'admin',
    ]

    const runMongoshViaStdin = (js: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const proc = spawn(mongosh, mongoshArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        let stderr = ''
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        const timeout = setTimeout(() => {
          proc.kill('SIGTERM')
          reject(new Error('mongosh timed out after 10 seconds'))
        }, 10000)

        proc.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })

        proc.on('close', (code) => {
          clearTimeout(timeout)
          if (code === 0) resolve()
          else reject(new Error(stderr || `mongosh exited with code ${code}`))
        })

        proc.stdin?.write(js)
        proc.stdin?.end()
      })

    try {
      await runMongoshViaStdin(script)
    } catch (error) {
      const err = error as Error
      if (
        err.message.includes('51003') ||
        err.message.includes('already exists')
      ) {
        // User exists — update password instead
        const updateScript = `db.getSiblingDB('${db}').updateUser('${username}',{pwd:${jsonPwd}})`
        await runMongoshViaStdin(updateScript)
      } else {
        throw error
      }
    }

    const connectionString = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`

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

export const mongodbEngine = new MongoDBEngine()
