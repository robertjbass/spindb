/**
 * TypeDB Engine Implementation
 *
 * TypeDB is a strongly-typed database for knowledge representation and reasoning
 * with its own query language (TypeQL).
 *
 * Key characteristics:
 * - Default main port: 1729 (gRPC protocol)
 * - HTTP port: main + 6271 (default 8000)
 * - Rust-native binary (no JRE)
 * - Separate console binary (typedb_console_bin) for interactive queries
 * - Default credentials: admin/password
 * - Config file based (config.yml per container)
 * - Query language: TypeQL
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, unlink, stat, readdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
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
import { typedbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  TYPEDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import {
  validateTypeDBIdentifier,
  requireTypeDBConsolePath,
  getConsoleBaseArgs,
  TYPEDB_DEFAULT_USERNAME,
  TYPEDB_DEFAULT_PASSWORD,
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

const ENGINE = 'typedb'
const engineDef = getEngineDefaults(ENGINE)

export class TypeDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'TypeDB'
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

  // Resolves version string to full version (e.g., '3' -> '3.8.0')
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return TYPEDB_VERSION_MAP[version] || version
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'typedb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that TypeDB binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', 'server', `typedb_server_bin${ext}`)
    return existsSync(serverPath)
  }

  // Check if a specific TypeDB version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return typedbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure TypeDB binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await typedbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binaries in config
    const ext = platformService.getExecutableExtension()
    const batExt = process.platform === 'win32' ? '.bat' : ''

    const typedbPath = join(binPath, 'bin', `typedb${batExt}`)
    if (existsSync(typedbPath)) {
      await configManager.setBinaryPath('typedb', typedbPath, 'bundled')
    }

    const consolePath = join(
      binPath,
      'bin',
      'console',
      `typedb_console_bin${ext}`,
    )
    if (existsSync(consolePath)) {
      await configManager.setBinaryPath(
        'typedb_console_bin',
        consolePath,
        'bundled',
      )
    }

    return binPath
  }

  /**
   * Initialize a new TypeDB data directory
   * Creates the directory structure and config.yml for TypeDB
   */
  async initDataDir(
    containerName: string,
    _version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    // Create data directory
    await mkdir(dataDir, { recursive: true })

    // Get port from options or use default
    const port = (options.port as number) || engineDef.defaultPort
    const httpPort = port + 6271 // Default: 1729 + 6271 = 8000

    // Generate config.yml for this container
    // Must include all required sections: server (with authentication, encryption), storage, logging, diagnostics
    const configContent = [
      'server:',
      `  address: 127.0.0.1:${port}`,
      '  http:',
      '    enabled: true',
      `    address: 127.0.0.1:${httpPort}`,
      '  authentication:',
      '    token-expiration-seconds: 5000',
      '  encryption:',
      '    enabled: false',
      '    certificate:',
      '    certificate-key:',
      '    ca-certificate:',
      'storage:',
      `  data-directory: "${dataDir}"`,
      'logging:',
      `  directory: "${containerDir}"`,
      'diagnostics:',
      '  reporting:',
      '    metrics: false',
      '    errors: false',
      '  monitoring:',
      '    enabled: false',
      '    port: 4104',
    ].join('\n')

    await writeFile(join(containerDir, 'config.yml'), configContent, 'utf-8')

    logDebug(`Created TypeDB data directory: ${dataDir}`)

    return dataDir
  }

  // Get the path to typedb_server_bin for a version
  private async getServerBinPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'typedb',
      version: fullVersion,
      platform,
      arch,
    })
    const serverPath = join(binPath, 'bin', 'server', `typedb_server_bin${ext}`)

    if (existsSync(serverPath)) {
      return serverPath
    }

    throw new Error(
      `TypeDB ${version} is not installed. Run: spindb engines download typedb ${version}`,
    )
  }

  // Get the path to typedb_console_bin for a version
  private async getConsolePath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'typedb',
      version: fullVersion,
      platform,
      arch,
    })
    const consolePath = join(
      binPath,
      'bin',
      'console',
      `typedb_console_bin${ext}`,
    )

    if (existsSync(consolePath)) {
      return consolePath
    }

    throw new Error(
      `TypeDB console ${version} is not installed. Run: spindb engines download typedb ${version}`,
    )
  }

  // Get the typedb launcher path for a version
  private async getTypeDBLauncherPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const batExt = process.platform === 'win32' ? '.bat' : ''

    const binPath = paths.getBinaryPath({
      engine: 'typedb',
      version: fullVersion,
      platform,
      arch,
    })
    const launcherPath = join(binPath, 'bin', `typedb${batExt}`)

    if (existsSync(launcherPath)) {
      return launcherPath
    }

    // Fall back to direct server binary
    return this.getServerBinPath(version)
  }

  /**
   * Start TypeDB server
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

    // Get TypeDB binary path
    let serverBinary: string | null = null
    const ext = platformService.getExecutableExtension()

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(
        binaryPath,
        'bin',
        'server',
        `typedb_server_bin${ext}`,
      )
      if (existsSync(serverPath)) {
        serverBinary = serverPath
        logDebug(`Using stored binary path: ${serverBinary}`)
      }
    }

    if (!serverBinary) {
      try {
        serverBinary = await this.getServerBinPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `TypeDB ${version} is not installed. Run: spindb engines download typedb ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'typedb.pid')
    const configFile = join(containerDir, 'config.yml')

    // Always regenerate config.yml to ensure paths and port are correct
    // (paths change after rename, port changes after port reassignment)
    await this.initDataDir(name, version, { port })

    onProgress?.({ stage: 'starting', message: 'Starting TypeDB...' })

    logDebug(`Starting TypeDB with config: ${configFile}`)

    // TypeDB server start using direct server binary with config
    const args = ['server', '--config', configFile]

    // Try launcher first, fall back to direct server binary
    let launcherPath: string
    try {
      launcherPath = await this.getTypeDBLauncherPath(version)
    } catch {
      launcherPath = serverBinary
      // When using server binary directly, don't pass 'server' subcommand
      args.splice(0, 1)
    }

    // Spawn the server process
    // Use 'ignore' for all stdio to prevent pipes from keeping the event loop alive
    // On Windows, .bat launcher files require shell: true to avoid spawn EINVAL
    const isWindows = process.platform === 'win32'
    const needsShell =
      isWindows &&
      (launcherPath.endsWith('.bat') || launcherPath.endsWith('.cmd'))

    const proc = spawn(launcherPath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      cwd: containerDir,
      windowsHide: true,
      ...(needsShell ? { shell: true } : {}),
    })

    // Wait for the process to spawn
    if (isWindows) {
      await new Promise<void>((resolve, reject) => {
        proc.on('error', (err) => {
          logDebug(`TypeDB spawn error on Windows: ${err.message}`)
          reject(new Error(`Failed to spawn TypeDB: ${err.message}`))
        })

        if (proc.pid) {
          writeFile(pidFile, proc.pid.toString(), 'utf-8')
            .then(() => {
              logDebug(`Windows: wrote PID file ${pidFile} (pid: ${proc.pid})`)
              proc.unref()
              setTimeout(resolve, 3000)
            })
            .catch((err) => {
              const errMsg = `Failed to write PID file: ${err instanceof Error ? err.message : String(err)}`
              logDebug(errMsg)
              try {
                if (proc.pid) process.kill(proc.pid, 'SIGTERM')
              } catch {
                // Process may have already exited
              }
              reject(new Error(errMsg))
            })
        } else {
          reject(new Error('Failed to spawn TypeDB: no PID available'))
        }
      })
    } else {
      const spawnTimeout = 30000
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(
            new Error(
              `TypeDB process failed to spawn within ${spawnTimeout}ms`,
            ),
          )
        }, spawnTimeout)

        proc.on('error', (err) => {
          clearTimeout(timeoutId)
          logDebug(`TypeDB spawn error: ${err.message}`)
          reject(new Error(`Failed to spawn TypeDB: ${err.message}`))
        })

        proc.on('close', (code, signal) => {
          clearTimeout(timeoutId)
          const errMsg = `TypeDB process exited early (code: ${code}, signal: ${signal})`
          logDebug(errMsg)
          reject(new Error(errMsg))
        })

        proc.on('spawn', async () => {
          clearTimeout(timeoutId)
          logDebug(`TypeDB process spawned (pid: ${proc.pid})`)

          proc.removeAllListeners('close')

          if (proc.pid) {
            try {
              await writeFile(pidFile, proc.pid.toString(), 'utf-8')
            } catch (err) {
              const errMsg = `Failed to write PID file: ${err instanceof Error ? err.message : String(err)}`
              logDebug(errMsg)

              try {
                process.kill(proc.pid, 'SIGTERM')
              } catch {
                // Process may have already exited
              }

              try {
                await unlink(pidFile)
              } catch {
                // Ignore
              }

              reject(new Error(errMsg))
              return
            }
          }

          proc.unref()
          setTimeout(resolve, 500)
        })
      })
    }

    // Wait for server to be ready
    const httpPort = port + 6271
    logDebug(
      `Waiting for TypeDB server to be ready on port ${port} (HTTP: ${httpPort})...`,
    )
    const ready = await this.waitForReady(httpPort, port)
    logDebug(`waitForReady returned: ${ready}`)

    if (!ready) {
      throw new Error(
        `TypeDB failed to start within timeout. Container: ${name}`,
      )
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // Wait for TypeDB to be ready via HTTP health check
  private async waitForReady(
    httpPort: number,
    _mainPort: number,
    timeoutMs = 60000,
  ): Promise<boolean> {
    logDebug(`waitForReady called for HTTP port ${httpPort}`)
    const startTime = Date.now()
    const checkInterval = 500

    let attempt = 0
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5000)

        const response = await fetch(`http://127.0.0.1:${httpPort}/`, {
          signal: controller.signal,
        })
        clearTimeout(timer)

        if (response.ok) {
          logDebug(`TypeDB ready on HTTP port ${httpPort}`)
          return true
        }
      } catch {
        if (attempt <= 3 || attempt % 10 === 0) {
          logDebug(`Health check attempt ${attempt} failed`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logWarning(`TypeDB did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop TypeDB server
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'typedb.pid')

    logDebug(`Stopping TypeDB container "${name}" on port ${port}`)

    // Find PID by port
    let pid: number | null = null

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
      logDebug(`Killing TypeDB process ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        const gracefulWait = process.platform === 'win32' ? 5000 : 2000
        await new Promise((resolve) => setTimeout(resolve, gracefulWait))

        if (platformService.isProcessRunning(pid)) {
          logWarning(`Graceful termination failed, force killing ${pid}`)
          await platformService.terminateProcess(pid, true)
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

    logDebug('TypeDB stopped')
  }

  // Get TypeDB server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { port } = container
    const httpPort = port + 6271

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(`http://127.0.0.1:${httpPort}/`, {
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (response.ok) {
        return { running: true, message: 'TypeDB is running' }
      }
      return { running: false, message: 'TypeDB is not running' }
    } catch {
      return { running: false, message: 'TypeDB is not running' }
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
      database: options.database || container.database,
      version,
    })
  }

  /**
   * Get connection string
   * TypeDB uses its own protocol on the main port
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    return `typedb://${TYPEDB_DEFAULT_USERNAME}:${TYPEDB_DEFAULT_PASSWORD}@127.0.0.1:${port}`
  }

  // Open TypeDB console interactive shell
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port, version } = container

    const consolePath = await this.getConsolePath(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(consolePath, getConsoleBaseArgs(port), spawnOptions)

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * Create a new database
   * TypeDB requires explicit database creation via console
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port, version } = container

    validateTypeDBIdentifier(database)

    const consolePath = await this.getConsolePath(version)

    const args = [
      ...getConsoleBaseArgs(port),
      '--command',
      `database create ${database}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(consolePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Created TypeDB database: ${database}`)
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

    validateTypeDBIdentifier(database)

    const consolePath = await this.getConsolePath(version)

    const args = [
      ...getConsoleBaseArgs(port),
      '--command',
      `database delete ${database}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(consolePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Dropped TypeDB database: ${database}`)
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
   * Estimate from data directory
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const dataDir = paths.getContainerDataPath(container.name, {
      engine: ENGINE,
    })

    try {
      const stats = await stat(dataDir)

      if (!stats.isDirectory()) {
        return null
      }

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
   * Dump from a remote TypeDB connection
   * Uses TypeDB console export
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
      const sanitized = connectionString.replace(
        /\/\/([^:]+):([^@]+)@/,
        '//***:***@',
      )
      throw new Error(
        `Invalid connection string: ${sanitized}\n` +
          'Expected format: typedb://host[:port][/database]',
      )
    }

    const host = url.hostname || '127.0.0.1'
    const port = parseInt(url.port, 10) || 1729
    const database = url.pathname.replace(/^\//, '') || 'default'

    logDebug(`Connecting to remote TypeDB at ${host}:${port} (db: ${database})`)

    // For remote dump, we need a local TypeDB console binary
    let consolePath: string | null = null
    const cached = await configManager.getBinaryPath('typedb_console_bin')
    if (cached && existsSync(cached)) {
      consolePath = cached
    }

    if (!consolePath) {
      throw new Error(
        'TypeDB console binary not found. Run: spindb engines download typedb 3\n' +
          'A local TypeDB console binary is needed to dump from remote connections.',
      )
    }

    // TypeDB exports schema and data as separate files
    const schemaPath = outputPath.replace('.typeql', '-schema.typeql')
    const dataPath = outputPath.replace('.typeql', '-data.typeql')

    return new Promise<DumpResult>((resolve, reject) => {
      const args = [
        ...getConsoleBaseArgs(port, host),
        '--command',
        `database export ${database} ${schemaPath} ${dataPath}`,
      ]

      const proc = spawn(consolePath!, args, {
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

  // Run a TypeQL file or inline statement
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port, version } = container
    const db = options.database || container.database

    const consolePath = await this.getConsolePath(version)

    if (options.file) {
      // Run TypeQL script file
      const args = [...getConsoleBaseArgs(port), '--script', options.file]

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(consolePath, args, {
          stdio: 'inherit',
        })

        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          if (code === 0) resolve()
          else if (code === null)
            reject(new Error(`typedb console was killed by signal ${signal}`))
          else reject(new Error(`typedb console exited with code ${code}`))
        })
      })
    } else if (options.sql) {
      // Run inline TypeQL via temp script file
      // TypeDB console --command mode doesn't support multi-step transaction flows;
      // each --command is a standalone top-level command. Transactions require --script.
      const scriptContent = `transaction schema ${db}\n\n${options.sql}\n\ncommit\n`
      const tempScript = join(
        tmpdir(),
        `spindb-typedb-${Date.now()}-${Math.random().toString(36).slice(2)}.tqls`,
      )

      try {
        await writeFile(tempScript, scriptContent, 'utf-8')

        const args = [...getConsoleBaseArgs(port), '--script', tempScript]

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(consolePath, args, {
            stdio: 'inherit',
          })

          proc.on('error', reject)
          proc.on('close', (code, signal) => {
            if (code === 0) resolve()
            else if (code === null)
              reject(new Error(`typedb console was killed by signal ${signal}`))
            else reject(new Error(`typedb console exited with code ${code}`))
          })
        })
      } finally {
        await unlink(tempScript).catch(() => {})
      }
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }

  /**
   * Execute a TypeQL query and return structured results
   * TypeDB doesn't return tabular results like SQL, but we normalize the output
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    _options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port, version } = container
    const db = container.database

    const consolePath = await this.getConsolePath(version)

    // TypeDB console --command mode doesn't support multi-step transaction flows;
    // each --command is a standalone top-level command. Use temp script for queries.
    const scriptContent = `transaction read ${db}\n\n${query}\n\nclose\n`
    const tempScript = join(
      tmpdir(),
      `spindb-typedb-query-${Date.now()}-${Math.random().toString(36).slice(2)}.tqls`,
    )

    try {
      await writeFile(tempScript, scriptContent, 'utf-8')

      return await new Promise((resolve, reject) => {
        const args = [...getConsoleBaseArgs(port), '--script', tempScript]

        const proc = spawn(consolePath, args, {
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

        const timeout = setTimeout(() => {
          proc.kill('SIGTERM')
          reject(new Error('Query timed out after 60 seconds'))
        }, 60000)

        proc.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })

        proc.on('close', (code) => {
          clearTimeout(timeout)
          if (code !== 0) {
            reject(
              new Error(stderr || `typedb console exited with code ${code}`),
            )
            return
          }

          // TypeDB console output is not tabular - return raw output as a single result
          resolve({
            columns: ['result'],
            rows: [{ result: stdout.trim() }],
            rowCount: 1,
          })
        })
      })
    } finally {
      await unlink(tempScript).catch(() => {})
    }
  }

  /**
   * List all databases
   * Uses TypeDB console 'database list' command
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { port, version } = container
    const consolePath = await this.getConsolePath(version)

    return new Promise((resolve, reject) => {
      const args = [...getConsoleBaseArgs(port), '--command', 'database list']

      const proc = spawn(consolePath, args, {
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
          reject(new Error(stderr || `typedb console exited with code ${code}`))
          return
        }

        try {
          // Parse database list output
          // Each line after the command echo is a database name
          const lines = stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)

          // Filter out command echoes (+ prefix) and prompts
          const databases = lines.filter(
            (line) =>
              !line.startsWith('+') &&
              !line.startsWith('>') &&
              !line.startsWith('database') &&
              !line.includes('connected') &&
              line.length > 0,
          )

          resolve(databases.length > 0 ? databases : [container.database])
        } catch {
          resolve([container.database])
        }
      })
    })
  }

  /**
   * Create a TypeDB user via console `user create` command.
   * TypeDB 3.x has built-in user management with password authentication.
   */
  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password } = options
    assertValidUsername(username)
    const { port, version } = container

    const consolePath = await this.getConsolePath(version)

    const args = [
      ...getConsoleBaseArgs(port),
      '--command',
      `user create ${username} ${password}`,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(consolePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          logDebug(`Created TypeDB user: ${username}`)
          resolve()
        } else {
          reject(new Error(`Failed to create user: ${stderr}`))
        }
      })
      proc.on('error', reject)
    })

    const connectionString = `typedb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}`

    return {
      username,
      password,
      connectionString,
      engine: container.engine,
      container: container.name,
    }
  }

  async getTypeDBConsolePath(version?: string): Promise<string> {
    return requireTypeDBConsolePath(version)
  }
}

export const typedbEngine = new TypeDBEngine()
