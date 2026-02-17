/**
 * TigerBeetle Engine Implementation
 *
 * TigerBeetle is a high-performance financial ledger database written in Zig,
 * with a custom binary protocol (not REST, not SQL).
 *
 * Key characteristics:
 * - Default port: 3000
 * - Single binary: `tigerbeetle` (server + REPL client)
 * - Two-step init: `tigerbeetle format` then `tigerbeetle start`
 * - No auth, no multi-database, custom binary protocol
 * - Health check: PID + TCP port (no HTTP endpoint)
 * - Backup: stop-and-copy of single data file
 * - REPL: `tigerbeetle repl --cluster=0 --addresses=port`
 * - `--development` flag required for local dev
 * - Abrupt shutdown (SIGTERM/SIGKILL) is safe by design
 */

import { spawn, execFileSync, type SpawnOptions } from 'child_process'
import { existsSync, openSync, closeSync } from 'fs'
import { mkdir, writeFile, readFile, unlink, stat } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { tigerbeetleBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  TIGERBEETLE_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
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
  type QueryResult,
  type QueryOptions,
  type CreateUserOptions,
  type UserCredentials,
} from '../../types'

const ENGINE = 'tigerbeetle'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Default cluster ID for local single-node development.
 * TigerBeetle requires a cluster ID for format, start, and REPL commands.
 * Cluster 0 is the standard default for local/single-node usage.
 */
const DEFAULT_CLUSTER_ID = 0

export class TigerBeetleEngine extends BaseEngine {
  name = ENGINE
  displayName = 'TigerBeetle'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return TIGERBEETLE_VERSION_MAP[version] || version
  }

  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'tigerbeetle',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `tigerbeetle${ext}`)
    return existsSync(serverPath)
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return tigerbeetleBinaryManager.isInstalled(version, platform, arch)
  }

  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await tigerbeetleBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binary in config
    const ext = platformService.getExecutableExtension()
    const toolPath = join(binPath, 'bin', `tigerbeetle${ext}`)
    if (existsSync(toolPath)) {
      await configManager.setBinaryPath('tigerbeetle', toolPath, 'bundled')
    }

    return binPath
  }

  /**
   * Initialize a new TigerBeetle data directory.
   * Creates the directory and runs `tigerbeetle format` to initialize the data file.
   */
  async initDataDir(
    containerName: string,
    version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    // Create data directory if it doesn't exist
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created TigerBeetle data directory: ${dataDir}`)
    }

    const dataFile = join(dataDir, '0_0.tigerbeetle')

    // Skip format if data file already exists (e.g., restoring from backup)
    if (existsSync(dataFile)) {
      logDebug(`TigerBeetle data file already exists: ${dataFile}`)
      return dataDir
    }

    // Get binary path for format command
    const tigerbeetleBinary = await this.getTigerBeetlePath(version)

    // Run tigerbeetle format to initialize the data file
    logDebug(`Formatting TigerBeetle data file: ${dataFile}`)

    try {
      execFileSync(
        tigerbeetleBinary,
        [
          'format',
          `--cluster=${DEFAULT_CLUSTER_ID}`,
          '--replica=0',
          '--replica-count=1',
          '--development',
          dataFile,
        ],
        {
          timeout: 30000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      logDebug(`TigerBeetle data file formatted successfully: ${dataFile}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('PermissionDenied')) {
        throw new Error(
          "TigerBeetle requires io_uring syscalls which are blocked by Docker's default seccomp profile.\n" +
            'Run your container with: docker run --security-opt seccomp=unconfined ...',
        )
      }
      throw new Error(`Failed to format TigerBeetle data file: ${msg}`)
    }

    return dataDir
  }

  // Get the path to tigerbeetle binary for a version
  async getTigerBeetlePath(version: string): Promise<string> {
    // Check config cache first
    const cached = await configManager.getBinaryPath('tigerbeetle')
    if (cached && existsSync(cached)) {
      return cached
    }

    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const ext = platformService.getExecutableExtension()

    const binPath = paths.getBinaryPath({
      engine: 'tigerbeetle',
      version: fullVersion,
      platform,
      arch,
    })
    const tigerbeetlePath = join(binPath, 'bin', `tigerbeetle${ext}`)

    if (existsSync(tigerbeetlePath)) {
      return tigerbeetlePath
    }

    throw new Error(
      `TigerBeetle ${version} is not installed. Run: spindb engines download tigerbeetle ${version}`,
    )
  }

  /**
   * Start TigerBeetle server
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

    // Get TigerBeetle binary path
    let tigerbeetleBinary: string | null = null
    const ext = platformService.getExecutableExtension()

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(binaryPath, 'bin', `tigerbeetle${ext}`)
      if (existsSync(serverPath)) {
        tigerbeetleBinary = serverPath
        logDebug(`Using stored binary path: ${tigerbeetleBinary}`)
      }
    }

    if (!tigerbeetleBinary) {
      try {
        tigerbeetleBinary = await this.getTigerBeetlePath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `TigerBeetle ${version} is not installed. Run: spindb engines download tigerbeetle ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'tigerbeetle.pid')
    const dataFile = join(dataDir, '0_0.tigerbeetle')

    if (!existsSync(dataFile)) {
      throw new Error(
        `TigerBeetle data file not found at ${dataFile}. Run: spindb create <name> --engine tigerbeetle`,
      )
    }

    onProgress?.({ stage: 'starting', message: 'Starting TigerBeetle...' })

    logDebug(`Starting TigerBeetle on port ${port}`)

    const args = [
      'start',
      `--addresses=127.0.0.1:${port}`,
      '--development',
      dataFile,
    ]

    // Redirect stdout/stderr to log file via file descriptor
    const logFd = openSync(logFile, 'a')

    const spawnOpts: SpawnOptions = {
      cwd: containerDir,
      stdio: ['ignore', logFd, logFd],
      detached: true,
    }

    if (isWindows()) {
      spawnOpts.windowsHide = true
    }

    const proc = spawn(tigerbeetleBinary!, args, spawnOpts)
    proc.unref()

    // Close fd in parent — child inherited its own copy
    closeSync(logFd)

    if (!proc.pid) {
      throw new Error('TigerBeetle server process failed to start (no PID)')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // Non-fatal
    }

    // Wait for TigerBeetle to be ready (TCP port check)
    const ready = await this.waitForReady(port)

    if (ready) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // Clean up the orphaned detached process before throwing
    if (platformService.isProcessRunning(proc.pid)) {
      try {
        await platformService.terminateProcess(proc.pid, true)
      } catch {
        // Ignore cleanup errors - best effort
      }
    }

    // Check log for errors
    let logError = ''
    try {
      const logContent = await readFile(logFile, 'utf-8')
      const recentLog = logContent.slice(-2000)
      if (recentLog.includes('PermissionDenied')) {
        throw new Error(
          "TigerBeetle requires io_uring syscalls which are blocked by Docker's default seccomp profile.\n" +
            'Run your container with: docker run --security-opt seccomp=unconfined ...',
        )
      }
      if (
        recentLog.includes('Address already in use') ||
        recentLog.includes('address already in use')
      ) {
        logError = `Port ${port} is already in use`
      }
    } catch (logReadError) {
      // Re-throw io_uring error, ignore other log read failures
      if (
        logReadError instanceof Error &&
        logReadError.message.includes('io_uring')
      ) {
        throw logReadError
      }
    }

    const errorDetails = [
      logError || 'TigerBeetle failed to start within timeout.',
      `Binary: ${tigerbeetleBinary}`,
      `Log file: ${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  /**
   * Wait for TigerBeetle to be ready by checking if the port is listening.
   * TigerBeetle has no HTTP health endpoint, so we use TCP port check.
   */
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      // Check if the port is no longer available (something is listening)
      const available = await portManager.isPortAvailable(port)
      if (!available) {
        logDebug(`TigerBeetle ready on port ${port}`)
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`TigerBeetle did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop TigerBeetle server.
   * SIGTERM is safe by design — TigerBeetle handles abrupt shutdown gracefully.
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'tigerbeetle.pid')

    logDebug(`Stopping TigerBeetle container "${name}" on port ${port}`)

    let pid: number | null = null

    // Read PID from file
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // Ignore
      }
    }

    // Fallback: find by port
    if (!pid || !platformService.isProcessRunning(pid)) {
      try {
        const pids = await platformService.findProcessByPort(port)
        if (pids.length > 0) {
          pid = pids[0]
        }
      } catch {
        // Ignore
      }
    }

    // Kill process if found
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing TigerBeetle process ${pid}`)
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

    // Wait for termination
    const terminationWait = isWindows() ? 3000 : 1000
    await new Promise((resolve) => setTimeout(resolve, terminationWait))

    // Cleanup PID file
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // Ignore
      }
    }

    logDebug('TigerBeetle stopped')
  }

  /**
   * Get TigerBeetle server status.
   * Uses PID file + process check, with port-based fallback.
   * No HTTP health endpoint available.
   */
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'tigerbeetle.pid')

    // Check PID file first
    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0 && platformService.isProcessRunning(pid)) {
          return {
            running: true,
            message: `TigerBeetle is running (PID: ${pid})`,
          }
        }
      } catch {
        // Ignore
      }
    }

    // Fallback: check by port
    try {
      const pids = await platformService.findProcessByPort(port)
      if (pids.length > 0) {
        return {
          running: true,
          message: `TigerBeetle is running (PID: ${pids[0]})`,
        }
      }
    } catch {
      // Ignore
    }

    return { running: false, message: 'TigerBeetle is not running' }
  }

  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup.
   * TigerBeetle must be stopped before restore.
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name } = container

    // Check if container is running
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `TigerBeetle container "${name}" must be stopped before restore. ` +
          `Run: spindb stop ${name}`,
      )
    }

    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })

    return restoreBackup(backupPath, {
      containerName: name,
      dataDir,
    })
  }

  /**
   * Get connection string.
   * TigerBeetle uses custom binary protocol — no URI scheme.
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    return `127.0.0.1:${port}`
  }

  /**
   * Open TigerBeetle REPL (interactive client).
   * Uses stdio: 'inherit' pattern from SurrealDB.
   */
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port, version } = container

    const tigerbeetleBinary = await this.getTigerBeetlePath(version)

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        tigerbeetleBinary,
        [
          'repl',
          `--cluster=${DEFAULT_CLUSTER_ID}`,
          `--addresses=127.0.0.1:${port}`,
        ],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * Create database — not supported.
   * TigerBeetle has no database concept.
   */
  async createDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    throw new Error(
      'TigerBeetle does not support multiple databases. ' +
        'Each container is a single ledger instance.',
    )
  }

  /**
   * Drop database — not supported.
   */
  async dropDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    throw new Error(
      'TigerBeetle does not support multiple databases. ' +
        'Use `spindb delete <container>` to remove the instance.',
    )
  }

  /**
   * Get database size from data file.
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const dataDir = paths.getContainerDataPath(container.name, {
      engine: ENGINE,
    })
    const dataFile = join(dataDir, '0_0.tigerbeetle')

    try {
      const stats = await stat(dataFile)
      return stats.size
    } catch {
      return null
    }
  }

  /**
   * Dump from connection string — not supported.
   * TigerBeetle uses a custom binary protocol that doesn't support remote dumps.
   */
  async dumpFromConnectionString(
    _connectionString: string,
    _outputPath: string,
  ): Promise<DumpResult> {
    throw new Error(
      'TigerBeetle does not support remote dumps.\n' +
        'TigerBeetle uses a custom binary protocol that requires direct file access.\n' +
        'To backup a remote TigerBeetle instance, stop the server and copy the data file directly.',
    )
  }

  /**
   * Create a backup.
   * TigerBeetle requires the server to be stopped for backup.
   */
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    const { name } = container
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })

    // Verify server is stopped
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `TigerBeetle container "${name}" must be stopped before backup. ` +
          `Run: spindb stop ${name}`,
      )
    }

    return createBackup(dataDir, outputPath, options)
  }

  /**
   * Run script — not supported.
   * TigerBeetle uses a custom binary protocol, not SQL or REST.
   */
  async runScript(
    _container: ContainerConfig,
    _options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    throw new Error(
      'TigerBeetle does not support script execution.\n' +
        'Use the TigerBeetle REPL for interactive operations: spindb connect <container>',
    )
  }

  /**
   * Execute query — not supported.
   * TigerBeetle uses a custom binary protocol.
   */
  async executeQuery(
    _container: ContainerConfig,
    _query: string,
    _options?: QueryOptions,
  ): Promise<QueryResult> {
    throw new Error(
      'TigerBeetle does not support SQL or REST queries.\n' +
        'Use the TigerBeetle REPL for interactive operations: spindb connect <container>\n' +
        'Or use a TigerBeetle client library in your application.',
    )
  }

  /**
   * List databases — TigerBeetle has no database concept.
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    return [container.database]
  }

  /**
   * Create user — not supported.
   * TigerBeetle has no authentication.
   */
  async createUser(
    _container: ContainerConfig,
    _options: CreateUserOptions,
  ): Promise<UserCredentials> {
    throw new Error(
      'TigerBeetle does not support user authentication.\n' +
        'Access is controlled at the network level.',
    )
  }
}

export const tigerbeetleEngine = new TigerBeetleEngine()
