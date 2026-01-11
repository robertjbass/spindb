/**
 * MongoDB Engine implementation
 * Manages MongoDB database containers using hostdb-downloaded binaries
 */

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
  assertValidDatabaseName,
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
  getPlatformInfo(): { platform: string; arch: string } {
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
  getBinaryUrl(version: string, platform: string, arch: string): string {
    return getBinaryUrl(version, platform, arch)
  }

  // Verify that MongoDB binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const mongodPath = join(binPath, 'bin', 'mongod')
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
    const isMac = process.platform === 'darwin'
    const useDetachedSpawn = isWindows() || isMac

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

  // Wait for MongoDB to be ready to accept connections
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    const mongosh = await configManager.getBinaryPath('mongosh')
    if (!mongosh) {
      // No mongosh available to verify readiness - assume ready after fork
      logDebug(
        `mongosh not found, assuming MongoDB ready on port ${port} without verification`,
      )
      return true
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
    const { port } = container
    const database = (options.database as string) || container.database

    return restoreBackup(backupPath, {
      port,
      database,
      drop: options.drop !== false,
      validateVersion: options.validateVersion !== false,
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
   * MongoDB creates databases implicitly - we just verify the connection works
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container

    const mongosh = await this.getMongoshPath()

    // MongoDB creates databases implicitly when you write to them
    // We just verify the connection and create an empty collection to ensure the db exists
    const cmd = buildMongoshCommand(
      mongosh,
      port,
      database,
      'db.createCollection("_spindb_init"); db.getCollectionNames();',
    )

    try {
      await execAsync(cmd, { timeout: 10000 })
    } catch (error) {
      const err = error as Error
      // Ignore "collection already exists" error
      if (!err.message.includes('already exists')) {
        throw error
      }
    }
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
    // Get mongodump from config or fallback to system PATH
    let mongodump = await configManager.getBinaryPath('mongodump')
    if (!mongodump || !existsSync(mongodump)) {
      mongodump = await platformService.findToolPath('mongodump')
    }
    if (!mongodump) {
      throw new Error(
        'mongodump not found. Download MongoDB binaries:\n' +
          '  Run: spindb engines download mongodb <version>\n' +
          '  Or download from: https://www.mongodb.com/try/download/database-tools',
      )
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
}

export const mongodbEngine = new MongoDBEngine()
