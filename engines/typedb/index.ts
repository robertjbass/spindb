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
import { portManager } from '../../core/port-manager'
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
  detectTypedbTxType,
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
  // TypeDB 3.11+ binds a dedicated localhost admin port (default 1728, the same
  // for every server). To let multiple TypeDB containers run at once, give each
  // its own admin port derived from the container port and offset clear of the
  // gRPC (port) and HTTP (port + 6271) bands. Returns null for < 3.11, whose
  // config schema has no `server.admin` block - so existing 3.8.x containers are
  // left untouched when their config is regenerated.
  private adminPortFor(version: string, port: number): number | null {
    const [major, minor] = normalizeVersion(version).split('.').map(Number)
    const supportsAdmin = major > 3 || (major === 3 && minor >= 11)
    return supportsAdmin ? port + 6372 : null
  }

  async initDataDir(
    containerName: string,
    version: string,
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
    const adminPort = this.adminPortFor(version, port) // 3.11+ only; null otherwise

    // Generate config.yml for this container
    // Must include all required sections: server (with authentication, encryption), storage, logging, diagnostics
    // Use forward slashes in YAML paths - backslashes in double-quoted YAML strings are
    // interpreted as escape sequences (\t → tab, \n → newline, etc.) which corrupts Windows paths
    const yamlDataDir = dataDir.replace(/\\/g, '/')
    const yamlContainerDir = containerDir.replace(/\\/g, '/')
    const configContent = [
      'server:',
      `  address: ${(options.bindAddress as string) ?? '127.0.0.1'}:${port}`,
      '  http:',
      '    enabled: true',
      `    address: ${(options.bindAddress as string) ?? '127.0.0.1'}:${httpPort}`,
      // TypeDB 3.11+ requires a `server.admin` block (the `port` field is
      // mandatory). Give each container a unique admin port so concurrent
      // TypeDB containers don't all fight over the default 1728. Omitted for
      // < 3.11, which doesn't understand this block.
      ...(adminPort !== null
        ? ['  admin:', '    enabled: true', `    port: ${adminPort}`]
        : []),
      '  authentication:',
      '    token-expiration-seconds: 5000',
      '  encryption:',
      '    enabled: false',
      '    certificate:',
      '    certificate-key:',
      '    ca-certificate:',
      'storage:',
      `  data-directory: "${yamlDataDir}"`,
      'logging:',
      `  directory: "${yamlContainerDir}"`,
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

    // Refuse to start if our gRPC or HTTP port is already held by another
    // process. TypeDB's readiness check and console both address the server by
    // port alone, so a foreign server here (e.g. a different TypeDB version on
    // the default 1729 / 8000) would be silently used instead of ours - which
    // surfaces later as opaque driver/protocol errors at query time. Fail loudly
    // up front instead. (We only get here when our own server is NOT running -
    // the alreadyRunning check above already returned for that case.)
    const httpPort = port + 6271
    const adminPort = this.adminPortFor(version, port)
    const portsToCheck =
      adminPort !== null ? [port, httpPort, adminPort] : [port, httpPort]
    for (const p of portsToCheck) {
      if (!(await portManager.isPortAvailable(p))) {
        const user = await portManager.getPortUser(p)
        const label =
          p === httpPort ? ' (HTTP)' : p === adminPort ? ' (admin)' : ''
        throw new Error(
          `Cannot start TypeDB "${name}": port ${p}${label}` +
            ` is already in use by another process - likely a different TypeDB ` +
            `server. Stop it, or recreate this container on a different port ` +
            `(spindb create ... --port <n>).` +
            (user ? `\n  ${user.replace(/\n/g, '\n  ')}` : ''),
        )
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
    await this.initDataDir(name, version, {
      port,
      bindAddress: container.bindAddress,
    })

    onProgress?.({ stage: 'starting', message: 'Starting TypeDB...' })

    logDebug(`Starting TypeDB with config: ${configFile}`)

    // TypeDB server start using direct server binary with config
    const args = ['server', '--config', configFile]

    // On Windows, use server binary directly to avoid .bat launcher's cmd.exe wrapper
    // which creates orphaned processes that prevent clean test/CLI exit.
    // On other platforms, try launcher first, fall back to direct server binary.
    const isWindows = process.platform === 'win32'
    let launcherPath: string
    if (isWindows && serverBinary) {
      launcherPath = serverBinary
      // When using server binary directly, don't pass 'server' subcommand
      args.splice(0, 1)
    } else {
      try {
        launcherPath = await this.getTypeDBLauncherPath(version)
      } catch {
        launcherPath = serverBinary!
        // When using server binary directly, don't pass 'server' subcommand
        args.splice(0, 1)
      }
    }

    // Spawn the server process
    // Use 'ignore' for all stdio to prevent pipes from keeping the event loop alive
    // On Windows, .bat/.cmd files would require shell: true, but we use the .exe directly
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
        let settled = false

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          logDebug(`TypeDB spawn error on Windows: ${err.message}`)
          reject(new Error(`Failed to spawn TypeDB: ${err.message}`))
        })

        // Detect early exit (e.g., bad config, missing deps)
        proc.on('close', (code, signal) => {
          if (settled) return
          settled = true
          const errMsg = `TypeDB process exited early on Windows (code: ${code}, signal: ${signal})`
          logDebug(errMsg)
          reject(new Error(errMsg))
        })

        if (proc.pid) {
          writeFile(pidFile, proc.pid.toString(), 'utf-8')
            .then(() => {
              logDebug(`Windows: wrote PID file ${pidFile} (pid: ${proc.pid})`)
              proc.unref()
              setTimeout(() => {
                if (settled) return
                settled = true
                proc.removeAllListeners('close')
                resolve()
              }, 3000)
            })
            .catch((err) => {
              if (settled) return
              settled = true
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
          settled = true
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
    logDebug(
      `Waiting for TypeDB server to be ready on port ${port} (HTTP: ${httpPort})...`,
    )
    const ready = await this.waitForReady(
      httpPort,
      port,
      normalizeVersion(version),
    )
    logDebug(`waitForReady returned: ${ready}`)

    if (!ready) {
      throw new Error(
        `TypeDB failed to start within timeout. Container: ${name}`,
      )
    }

    // Confirm the server that answered is the one we launched, not a foreign
    // process that grabbed the port between the pre-flight check and bind. The
    // launcher execs the server binary, so proc.pid is the listening pid on
    // macOS/Linux. If a different pid owns the port, our server didn't bind -
    // stop our orphan and fail loudly instead of using someone else's server.
    // (Empty result = lookup unavailable; don't false-fail on it.)
    if (!isWindows && proc.pid) {
      const owners = await platformService
        .findProcessByPort(port)
        .catch(() => [] as number[])
      if (owners.length > 0 && !owners.includes(proc.pid)) {
        try {
          process.kill(proc.pid, 'SIGTERM')
        } catch {
          // our process already exited
        }
        throw new Error(
          `Cannot start TypeDB "${name}": port ${port} is held by another ` +
            `process (pid ${owners.join(', ')}), not the server we launched ` +
            `(pid ${proc.pid}). A different TypeDB server is using this port.`,
        )
      }
    }

    // On Windows with .bat launcher, the recorded PID is cmd.exe (not the actual server).
    // Find the real server PID by port and update the PID file (same pattern as QuestDB).
    if (isWindows) {
      try {
        const pids = await platformService.findProcessByPort(port)
        if (pids.length > 0) {
          await writeFile(pidFile, pids[0].toString(), 'utf-8')
          logDebug(
            `Windows: updated PID file with actual server PID: ${pids[0]}`,
          )
        }
      } catch {
        // Non-fatal: stop() also looks up by port
      }
    }

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  // Fetch the version the server on this HTTP port reports. TypeDB exposes
  // GET /v1/version -> { "version": "3.11.5", ... }. Returns null if the
  // endpoint is unreachable or doesn't report a version.
  private async fetchServerVersion(httpPort: number): Promise<string | null> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(`http://127.0.0.1:${httpPort}/v1/version`, {
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!response.ok) return null
      const body = (await response.json()) as { version?: unknown }
      return typeof body.version === 'string' ? body.version : null
    } catch {
      return null
    }
  }

  // Wait for TypeDB to be ready via HTTP health check
  private async waitForReady(
    httpPort: number,
    _mainPort: number,
    expectedVersion: string,
    timeoutMs = 60000,
  ): Promise<boolean> {
    logDebug(`waitForReady called for HTTP port ${httpPort}`)
    const startTime = Date.now()
    const checkInterval = 500

    let attempt = 0
    while (Date.now() - startTime < timeoutMs) {
      attempt++
      let healthy = false
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(`http://127.0.0.1:${httpPort}/health`, {
          signal: controller.signal,
        })
        healthy = response.ok
      } catch {
        // Transport/timeout errors are transient - keep polling. Only the
        // /health fetch is retried here; the version check below must NOT be,
        // or its mismatch error would be swallowed and surface as a generic
        // start timeout.
        if (attempt <= 3 || attempt % 10 === 0) {
          logDebug(`Health check attempt ${attempt} failed`)
        }
      } finally {
        clearTimeout(timer)
      }

      if (healthy) {
        // Confirm this is the server we started, not a foreign TypeDB that
        // happens to hold the port. A version mismatch means we're talking to
        // someone else's server (the protocol-7-vs-8 incident's root cause) -
        // looping won't fix that, so fail loudly. This throw is deliberately
        // OUTSIDE the fetch try/catch so it propagates to start() instead of
        // being retried. A null reading is transient; keep polling.
        const serverVersion = await this.fetchServerVersion(httpPort)
        if (serverVersion && serverVersion !== expectedVersion) {
          throw new Error(
            `Port ${httpPort} is serving TypeDB ${serverVersion}, but this ` +
              `container expects ${expectedVersion}. A different TypeDB server ` +
              `is running on this port - stop it, or recreate the container on ` +
              `a different port.`,
          )
        }
        logDebug(`TypeDB ready on HTTP port ${httpPort}`)
        return true
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
    const { port, version } = container
    const httpPort = port + 6271

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(`http://127.0.0.1:${httpPort}/health`, {
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (response.ok) {
        // A healthy server on the port isn't necessarily ours - guard against a
        // foreign TypeDB on the same port being reported as this container.
        const expected = normalizeVersion(version)
        const serverVersion = await this.fetchServerVersion(httpPort)
        if (serverVersion && serverVersion !== expected) {
          return {
            running: false,
            message: `A different TypeDB version (${serverVersion}) is running on port ${port}; this container expects ${expected}.`,
          }
        }
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
    const username = url.username
      ? decodeURIComponent(url.username)
      : TYPEDB_DEFAULT_USERNAME
    const password = url.password
      ? decodeURIComponent(url.password)
      : TYPEDB_DEFAULT_PASSWORD

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
    let schemaPath: string
    let dataPath: string
    if (outputPath.endsWith('.typeql')) {
      const basePath = outputPath.slice(0, -'.typeql'.length)
      schemaPath = `${basePath}-schema.typeql`
      dataPath = `${basePath}-data.typeql`
    } else {
      schemaPath = outputPath + '-schema.typeql'
      dataPath = outputPath + '-data.typeql'
    }

    // Build console args with URL credentials (may differ from local defaults)
    const tlsDisabled = url.protocol !== 'https:'
    return new Promise<DumpResult>((resolve, reject) => {
      const args = [
        '--address',
        `${host}:${port}`,
        ...(tlsDisabled ? ['--tls-disabled'] : []),
        '--username',
        username,
        '--password',
        password,
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
    options: {
      file?: string
      sql?: string
      database?: string
      transactionType?: 'read' | 'write' | 'schema'
    },
  ): Promise<void> {
    const { port, version } = container
    const db = options.database || container.database

    if (!db) {
      throw new Error(
        'Database name is required. Specify --database or set a default database on the container.',
      )
    }

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
      // Caller override wins; otherwise classify the buffer the same way the
      // query path does, so `spindb run` and `spindb query` agree.
      const txType: 'read' | 'write' | 'schema' =
        options.transactionType ?? detectTypedbTxType(options.sql)
      const txEnd = txType === 'read' ? 'close' : 'commit'
      const scriptContent = `transaction ${txType} ${db}\n\n${options.sql}\n\n${txEnd}\n`
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
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port, version } = container
    // Honor a caller-supplied database (the `-d` flag in `spindb query`); fall
    // back to the container's default. Matches the other engines' executeQuery.
    const db = options?.database || container.database

    if (!db) {
      throw new Error(
        'Database name is required. Specify --database or set a default database on the container.',
      )
    }

    // Structured callers (`spindb query --json`, the desktop/cloud consoles)
    // get TypeDB 3.x's HTTP /v1/query conceptRows — entities/attributes/types
    // as JSON objects, matching the rich result the managed cloud renders. The
    // human table output (no --json) stays on the console path below, byte-for-
    // byte unchanged. A genuine query error (bad TypeQL, type-inference) is
    // re-thrown. Transport/availability failures fall back to the console only
    // for READ queries: a mutating query may have already committed over HTTP,
    // so retrying it on the console could duplicate the write — those re-throw.
    if (options?.structured) {
      try {
        return await this.executeQueryViaHttp(port, db, query, options)
      } catch (error) {
        if (error instanceof TypedbQueryError) throw error
        // A transport failure after a mutating HTTP request may have already
        // committed server-side; retrying on the console could duplicate the
        // write. Only fall back for read-only queries.
        if (detectTypedbTxType(query) !== 'read') throw error
        logDebug(
          `TypeDB HTTP query failed (${
            error instanceof Error ? error.message : String(error)
          }); falling back to console`,
        )
      }
    }

    const consolePath = await this.getConsolePath(version)

    // TypeDB console --command mode doesn't support multi-step transaction flows;
    // each --command is a standalone top-level command. Use temp script for queries.
    // The transaction type must match what the query needs - a read transaction
    // rejects schema (`define`/`undefine`/`redefine`) and data writes
    // (`insert`/`delete`/`update`/`put`), so detect it from the whole buffer.
    const txType = detectTypedbTxType(query)
    const txEnd = txType === 'read' ? 'close' : 'commit'
    const scriptContent = `transaction ${txType} ${db}\n\n${query}\n\n${txEnd}\n`
    const tempScript = join(
      tmpdir(),
      `spindb-typedb-query-${Date.now()}-${Math.random().toString(36).slice(2)}.tqls`,
    )

    try {
      await writeFile(tempScript, scriptContent, 'utf-8')

      return await new Promise((resolve, reject) => {
        const args = [
          ...getConsoleBaseArgs(port, '127.0.0.1', true, {
            username: options?.username,
            password: options?.password,
          }),
          '--script',
          tempScript,
        ]

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
   * Run a TypeQL query through TypeDB 3.x's HTTP API and return structured
   * conceptRows (entities/attributes/types as JSON objects), matching the
   * shape the managed cloud renders. Mirrors layerbase-cloud's query-proxy:
   * sign in for a token, POST /v1/query, then unwrap each answer's `data`
   * envelope so the columns are the query variables. Throws TypedbQueryError
   * on a query-level failure so executeQuery surfaces it rather than retrying
   * on the console.
   */
  private async executeQueryViaHttp(
    port: number,
    db: string,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const base = `http://127.0.0.1:${port + 6271}` // gRPC port + 6271 = HTTP API
    const username = options?.username || TYPEDB_DEFAULT_USERNAME
    const password = options?.password || TYPEDB_DEFAULT_PASSWORD

    const token = await typedbHttpSignin(base, username, password)

    const transactionType = detectTypedbTxType(query)
    const res = await typedbHttpFetch(
      `${base}/v1/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          databaseName: db,
          transactionType,
          query,
          commit: transactionType !== 'read',
        }),
      },
      60_000,
    )

    if (!res.ok) {
      throw new TypedbQueryError(await readTypedbHttpError(res))
    }

    const body = (await res.json()) as TypedbQueryResponse
    return shapeTypedbConceptRows(body)
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

          resolve(
            databases.length > 0
              ? databases
              : container.database
                ? [container.database]
                : [],
          )
        } catch {
          resolve(container.database ? [container.database] : [])
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

      proc.on('close', async (code) => {
        if (code === 0) {
          logDebug(`Created TypeDB user: ${username}`)
          resolve()
        } else if (stderr.toLowerCase().includes('already exists')) {
          // User exists - update password instead.
          //
          // The TypeDB 3.x console subcommand is `update-password`, not
          // `password-update`. The words were transposed here, so every
          // password rotation against an existing user (including the
          // built-in admin) failed with "Unrecognised 'user' subcommand:
          // 'password-update <pw>'", caught by the close handler and
          // bubbled up as "Failed to update user password" — see typedb-
          // console main.rs CommandLeaf registration: the canonical name
          // is "update-password". Verified across 3.8.0..3.10.1 console
          // releases.
          logDebug(`User "${username}" already exists, updating password`)
          try {
            const updateArgs = [
              ...getConsoleBaseArgs(port),
              '--command',
              `user update-password ${username} ${password}`,
            ]
            await new Promise<void>((res, rej) => {
              const updateProc = spawn(consolePath, updateArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              let updateStderr = ''
              updateProc.stderr?.on('data', (data: Buffer) => {
                updateStderr += data.toString()
              })
              updateProc.on('close', (updateCode) => {
                if (updateCode === 0) {
                  logDebug(`Updated password for TypeDB user: ${username}`)
                  res()
                } else {
                  rej(
                    new Error(
                      `Failed to update user password: ${updateStderr}`,
                    ),
                  )
                }
              })
              updateProc.on('error', rej)
            })
            resolve()
          } catch (error) {
            reject(error)
          }
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

// ── TypeDB HTTP /v1/query transport (structured conceptRows) ────────────────
// TypeDB 3.x exposes a REST/HTTP API on `gRPC port + 6271`. Querying through
// it (instead of the text-only console) yields structured concept answers,
// matching what layerbase-cloud's query-proxy renders. These are the
// spindb-local equivalent: a direct fetch to 127.0.0.1 (the cloud shells the
// same calls through docker-exec curl because its TypeDB port is in-container).

type TypedbQueryResponse = {
  queryType?: string
  answerType?: 'ok' | 'conceptRows' | 'conceptDocuments'
  answers?: unknown[]
  warning?: string
}

/**
 * Raised when TypeDB's HTTP API rejects a query (bad TypeQL, type-inference,
 * auth). Distinct from transport failures so executeQuery surfaces it to the
 * caller instead of silently retrying on the console.
 */
class TypedbQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TypedbQueryError'
  }
}

// fetch with an abort-based timeout, matching fetchServerVersion's pattern.
async function typedbHttpFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function typedbHttpSignin(
  base: string,
  username: string,
  password: string,
): Promise<string> {
  const res = await typedbHttpFetch(
    `${base}/v1/signin`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    },
    15_000,
  )
  if (!res.ok) {
    // Explicit auth rejection: the console path uses the same credentials and
    // would fail identically, so surface it instead of falling back.
    if (res.status === 401 || res.status === 403) {
      throw new TypedbQueryError(
        `TypeDB authentication failed (${res.status}). Check the database username and password.`,
      )
    }
    // Other failures are likely transport/server issues — let the caller fall
    // back to the console path.
    throw new Error(`TypeDB signin failed: ${res.status} ${res.statusText}`)
  }
  const parsed = (await res.json()) as { token?: unknown }
  if (typeof parsed.token !== 'string' || !parsed.token) {
    throw new Error('TypeDB signin response missing "token"')
  }
  return parsed.token
}

/**
 * Convert a TypeDB /v1/query response into spindb's QueryResult. `conceptRows`
 * answers arrive as `{ data: { <var>: <concept> }, involvedBlocks: [...] }`;
 * unwrap `data` so the columns are the query variables. `conceptDocuments`
 * (from `fetch`) pass through as-is. Rendering each concept to a readable
 * label is the consumer's job (the desktop / cloud query console).
 */
function shapeTypedbConceptRows(body: TypedbQueryResponse): QueryResult {
  const answers = Array.isArray(body.answers) ? body.answers : []

  // A schema/data write with no returned rows (define, undefine, plain insert)
  // reports `ok` — surface a single OK cell so callers show success feedback.
  if (body.answerType === 'ok') {
    return { columns: ['result'], rows: [{ result: 'OK' }], rowCount: 1 }
  }

  // An empty read (a match with no matches) is genuinely zero rows — don't
  // synthesize an 'OK' cell for it.
  if (answers.length === 0) {
    return { columns: [], rows: [], rowCount: 0 }
  }

  const toRow = (a: unknown): Record<string, unknown> => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { value: a }
    const obj = a as Record<string, unknown>
    if (body.answerType === 'conceptRows') {
      const data = obj.data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data as Record<string, unknown>
      }
    }
    return obj
  }
  const rows = answers.map(toRow)

  const columns = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row)) columns.add(key)
  }

  return { columns: Array.from(columns), rows, rowCount: rows.length }
}

async function readTypedbHttpError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string }
    if (parsed.message) {
      return parsed.code ? `${parsed.code}: ${parsed.message}` : parsed.message
    }
  } catch {
    // not JSON — fall through to the raw text
  }
  return text.slice(0, 500) || `${res.status} ${res.statusText}`
}
