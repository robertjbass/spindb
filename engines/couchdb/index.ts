import { spawn, execSync, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join, dirname } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { couchdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  COUCHDB_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { couchdbApiRequest } from './api-client'
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

const ENGINE = 'couchdb'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Get the correct extension for CouchDB binary.
 * On Windows, CouchDB uses a .cmd batch file, not .exe
 */
function getCouchDBExtension(): string {
  return isWindows() ? '.cmd' : ''
}

/**
 * Generate CouchDB local.ini configuration content
 * CouchDB 3.x requires at least one admin account to start
 */
function generateCouchDBConfig(options: {
  port: number
  dataDir: string
  logDir: string
  bindAddress?: string
}): string {
  const bindAddress = options.bindAddress || '127.0.0.1'

  return `; SpinDB generated CouchDB configuration
[couchdb]
database_dir = ${options.dataDir}
view_index_dir = ${options.dataDir}

[chttpd]
port = ${options.port}
bind_address = ${bindAddress}
; Allow anonymous access for local development (no login required)
require_valid_user = false

[chttpd_auth]
; Allow anonymous access to Fauxton dashboard
require_valid_user = false

[log]
file = ${options.logDir}/couchdb.log
level = info

[admins]
; CouchDB 3.x requires admin account - credentials available if needed: admin/admin
admin = admin
`
}

/**
 * Generate container-specific vm.args with unique Erlang node name
 * Each CouchDB instance needs a unique node name to avoid conflicts
 */
function generateVmArgs(port: number, _containerDir: string): string {
  // Use port in node name to ensure uniqueness
  const nodeName = `couchdb_${port}@127.0.0.1`

  // Read base vm.args and replace the node name
  return `# SpinDB generated CouchDB vm.args
# Unique node name based on port to allow multiple instances
-name ${nodeName}

# All nodes must share the same magic cookie for distributed Erlang to work.
# -setcookie

# Which interfaces should the node listen on?
-kernel inet_dist_use_interface {127,0,0,1}

# Tell kernel and SASL not to log anything
-kernel error_logger silent
-sasl sasl_error_logger false

# Prevent overlapping partitions
-kernel prevent_overlapping_partitions false

# Erlang process limit
+P 1048576

# Increase the pool of dirty IO schedulers
+SDio 16

# Increase distribution buffer size
+zdbbl 32768

# Disable interactive shell
+Bd -noinput

# Set maximum SSL session lifetime
-ssl session_lifetime 300

# OS Mon Settings - disable all monitoring on Windows to avoid win32sysinfo issues
-os_mon start_cpu_sup false
-os_mon start_memsup false
-os_mon start_disksup false
`
}

/**
 * Generate Erlang sys.config to disable os_mon features before application starts.
 * On Windows, os_mon tries to use win32sysinfo which may crash if the port program
 * is missing or broken. Setting these in sys.config takes effect before os_mon starts.
 */
function generateSysConfig(): string {
  // Minimal Erlang sys.config - no comments, just config
  // os_mon settings must be set BEFORE the application starts
  return `[{os_mon,[{start_cpu_sup,false},{start_disksup,false},{start_memsup,false}]}].
`
}

/**
 * Parse a CouchDB connection string for remote operations
 */
function parseCouchDBConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
  database?: string
} {
  let url: URL
  let scheme = 'http'

  // Handle couchdb:// scheme by converting to http://
  let normalized = connectionString.trim()
  if (normalized.startsWith('couchdb://')) {
    normalized = normalized.replace('couchdb://', 'http://')
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
      `Invalid CouchDB connection string: ${connectionString}\n` +
        'Expected format: http://host:port or couchdb://host:port',
    )
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // Handle basic auth if present
  if (url.username && url.password) {
    const auth = Buffer.from(`${url.username}:${url.password}`).toString(
      'base64',
    )
    headers['Authorization'] = `Basic ${auth}`
  }

  // Construct base URL without auth and query params
  const port = url.port || '5984'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  // Extract database from pathname
  const pathname = url.pathname || ''
  const database =
    pathname.length > 1 ? pathname.slice(1).split('/')[0] : undefined

  return { baseUrl, headers, database }
}

/**
 * Make an HTTP request to a remote CouchDB server
 */
async function remoteCouchDBRequest(
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
        `Remote CouchDB request timed out after ${timeoutMs / 1000}s: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export class CouchDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'CouchDB'
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

  // Resolves version string to full version (e.g., '3' -> '3.5.1')
  resolveFullVersion(version: string): string {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    return COUCHDB_VERSION_MAP[version] || `${version}.0.0`
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'couchdb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that CouchDB binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    // CouchDB has a startup script rather than a direct binary
    // On Windows it's .cmd, on Unix it's just 'couchdb'
    const serverPath = join(binPath, 'bin', `couchdb${getCouchDBExtension()}`)
    return existsSync(serverPath)
  }

  // Check if a specific CouchDB version is installed
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return couchdbBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure CouchDB binaries are available for a specific version
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await couchdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binaries in config
    const toolPath = join(binPath, 'bin', `couchdb${getCouchDBExtension()}`)
    if (existsSync(toolPath)) {
      await configManager.setBinaryPath('couchdb', toolPath, 'bundled')
    }

    return binPath
  }

  /**
   * Initialize a new CouchDB data directory
   */
  async initDataDir(
    containerName: string,
    _version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })
    const port = (options.port as number) || engineDef.defaultPort

    // Create directories
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created CouchDB data directory: ${dataDir}`)
    }

    const logDir = join(containerDir, 'log')
    if (!existsSync(logDir)) {
      await mkdir(logDir, { recursive: true })
    }

    // Generate local.ini config
    const configPath = join(containerDir, 'local.ini')
    const configContent = generateCouchDBConfig({
      port,
      dataDir,
      logDir,
    })
    await writeFile(configPath, configContent)
    logDebug(`Generated CouchDB config: ${configPath}`)

    // Generate container-specific vm.args with unique node name
    const vmArgsPath = join(containerDir, 'vm.args')
    const vmArgsContent = generateVmArgs(port, containerDir)
    await writeFile(vmArgsPath, vmArgsContent)
    logDebug(`Generated CouchDB vm.args: ${vmArgsPath}`)

    return dataDir
  }

  // Get the path to couchdb server
  async getCouchDBServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'couchdb',
      version: fullVersion,
      platform,
      arch,
    })
    const serverPath = join(binPath, 'bin', `couchdb${getCouchDBExtension()}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `CouchDB ${version} is not installed. Run: spindb engines download couchdb ${version}`,
    )
  }

  // Get the path to couchdb binary
  async getCouchDBPath(version?: string): Promise<string> {
    const cached = await configManager.getBinaryPath('couchdb')
    if (cached && existsSync(cached)) {
      return cached
    }

    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'couchdb',
        version: fullVersion,
        platform,
        arch,
      })
      const couchdbPath = join(binPath, 'bin', `couchdb${getCouchDBExtension()}`)
      if (existsSync(couchdbPath)) {
        return couchdbPath
      }
    }

    throw new Error(
      'couchdb not found. Run: spindb engines download couchdb <version>',
    )
  }

  /**
   * Start CouchDB server
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

    // Find couchdb binary
    let couchdbServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const serverPath = join(binaryPath, 'bin', `couchdb${getCouchDBExtension()}`)
      if (existsSync(serverPath)) {
        couchdbServer = serverPath
        logDebug(`Using stored binary path: ${couchdbServer}`)
      }
    }

    if (!couchdbServer) {
      try {
        couchdbServer = await this.getCouchDBServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `CouchDB ${version} is not installed. Run: spindb engines download couchdb ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    logDebug(`Using couchdb for version ${version}: ${couchdbServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'local.ini')
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logDir = join(containerDir, 'log')
    const logFile = join(logDir, 'couchdb.log')
    const pidFile = join(containerDir, 'couchdb.pid')

    // Check port availability
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckStart = Date.now()
    const portCheckInterval = 1000

    while (!(await portManager.isPortAvailable(port))) {
      if (Date.now() - portCheckStart >= portWaitTimeout) {
        throw new Error(`Port ${port} is already in use.`)
      }
      logDebug(`Waiting for port ${port} to become available...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    // Regenerate config with current port
    const configContent = generateCouchDBConfig({
      port,
      dataDir,
      logDir,
    })
    await writeFile(configPath, configContent)

    // Regenerate vm.args with unique node name for this port
    const vmArgsPath = join(containerDir, 'vm.args')
    const vmArgsContent = generateVmArgs(port, containerDir)
    await writeFile(vmArgsPath, vmArgsContent)

    onProgress?.({ stage: 'starting', message: 'Starting CouchDB...' })

    logDebug(`Starting couchdb with config: ${configPath}`)

    // Get the binary directory for default config paths
    const binDir = dirname(dirname(couchdbServer))
    const defaultIni = join(binDir, 'etc', 'default.ini')

    // CouchDB uses COUCHDB_INI_FILES to load config files in order
    // COUCHDB_ARGS_FILE specifies custom vm.args with unique node name
    // On Windows, CouchDB may need additional paths set
    const env: Record<string, string | undefined> = {
      ...process.env,
      COUCHDB_INI_FILES: `${defaultIni} ${configPath}`,
      COUCHDB_ARGS_FILE: vmArgsPath,
      // Set CouchDB binary directory for Windows
      COUCHDB_BINDIR: join(binDir, 'bin'),
      COUCHDB_QUERY_SERVER_JAVASCRIPT: join(binDir, 'bin', 'couchjs'),
    }

    // On Windows, use sys.config to disable os_mon before it starts
    // The vm.args settings are too late - os_mon crashes during init
    // Erlang reads releases/sys.config at startup, so we modify that file
    if (isWindows()) {
      const sysConfigContent = generateSysConfig()

      // The CRITICAL location - Erlang release reads from releases/sys.config
      const releasesSysConfig = join(binDir, 'releases', 'sys.config')
      await writeFile(releasesSysConfig, sysConfigContent)

      // Copy vm.args to where Windows CouchDB expects it
      const expectedVmArgs = join(binDir, 'etc', 'vm.args')
      await writeFile(expectedVmArgs, vmArgsContent)

      // Also update releases/vm.args
      const releasesVmArgs = join(binDir, 'releases', 'vm.args')
      await writeFile(releasesVmArgs, vmArgsContent)

      // AGGRESSIVE FIX: Modify the os_mon.app file directly to disable features
      // This sets the default env values in the application spec itself
      const osMonAppPath = join(binDir, 'lib', 'os_mon-2.9.1', 'ebin', 'os_mon.app')
      try {
        const osMonApp = await readFile(osMonAppPath, 'utf8')
        // Replace the default env settings to disable all features
        const modifiedApp = osMonApp
          .replace('{start_cpu_sup, true}', '{start_cpu_sup, false}')
          .replace('{start_disksup, true}', '{start_disksup, false}')
          .replace('{start_memsup, true}', '{start_memsup, false}')
        await writeFile(osMonAppPath, modifiedApp)
        if (process.env.DEBUG === 'spindb') {
          console.error(`[CouchDB Debug] Modified os_mon.app to disable features`)
        }
      } catch (err) {
        if (process.env.DEBUG === 'spindb') {
          console.error(`[CouchDB Debug] Failed to modify os_mon.app: ${err}`)
        }
      }

      // Add os_mon priv/bin to PATH so win32sysinfo.exe can be found
      const osMonPrivBin = join(binDir, 'lib', 'os_mon-2.9.1', 'priv', 'bin')
      const existingPath = env.PATH || process.env.PATH || ''
      env.PATH = `${osMonPrivBin};${existingPath}`

      if (process.env.DEBUG === 'spindb') {
        console.error(`[CouchDB Debug] Wrote sys.config to ${releasesSysConfig}`)
        console.error(`[CouchDB Debug] Wrote vm.args to ${releasesVmArgs}`)
        console.error(`[CouchDB Debug] Added to PATH: ${osMonPrivBin}`)
      }
    }


    // Spawn CouchDB process
    if (isWindows()) {
      return new Promise((resolve, reject) => {
        // On Windows, run from the CouchDB installation directory
        // The Erlang VM expects to find files relative to its installation
        const spawnOpts: SpawnOptions = {
          cwd: binDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
          env,
        }

        // On Windows, .cmd files must be executed via cmd.exe
        // Debug: try running couchdb to see what error we get
        if (process.env.DEBUG === 'spindb') {
          try {
            const testResult = execSync(`"${couchdbServer}" 2>&1`, {
              cwd: binDir,
              env,
              timeout: 10000,
              encoding: 'utf8',
            })
            console.error(`[CouchDB Debug] Output: ${testResult}`)
          } catch (err) {
            const e = err as { message?: string; stderr?: string; stdout?: string }
            console.error(`[CouchDB Debug] Error: ${e.message}`)
            console.error(`[CouchDB Debug] stdout: ${e.stdout}`)
            console.error(`[CouchDB Debug] stderr: ${e.stderr}`)
          }
        }
        const proc = spawn('cmd.exe', ['/c', couchdbServer!], spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`Failed to spawn CouchDB server: ${err.message}`))
        })

        proc.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          const reason = signal ? `signal ${signal}` : `code ${code}`
          reject(
            new Error(
              `CouchDB process exited unexpectedly (${reason}).\n` +
                `Stderr: ${stderrOutput || '(none)'}\n` +
                `Stdout: ${stdoutOutput || '(none)'}`,
            ),
          )
        })

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          stdoutOutput += str
          logDebug(`couchdb stdout: ${str}`)
        })
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          stderrOutput += str
          logDebug(`couchdb stderr: ${str}`)
        })

        proc.unref()

        setTimeout(async () => {
          if (settled) return

          if (!proc.pid) {
            settled = true
            reject(new Error('CouchDB server process failed to start (no PID)'))
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

            if (proc.pid && platformService.isProcessRunning(proc.pid)) {
              try {
                await platformService.terminateProcess(proc.pid, true)
              } catch {
                // Ignore cleanup errors
              }
            }

            reject(
              new Error(
                `CouchDB failed to start within timeout.\n` +
                  `Binary: ${couchdbServer}\n` +
                  `Config: ${configPath}\n` +
                  `Log file: ${logFile}`,
              ),
            )
          }
        }, 500)
      })
    }

    // macOS/Linux
    const proc = spawn(couchdbServer, [], {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      env,
    })
    proc.unref()

    if (!proc.pid) {
      throw new Error('CouchDB server process failed to start (no PID)')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // Non-fatal
    }

    const ready = await this.waitForReady(port)

    if (ready) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    throw new Error(
      `CouchDB failed to start within timeout.\n` +
        `Binary: ${couchdbServer}\n` +
        `Config: ${configPath}\n` +
        `Log file: ${logFile}`,
    )
  }

  // Wait for CouchDB to be ready
  private async waitForReady(port: number, timeoutMs = 30000): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await couchdbApiRequest(port, 'GET', '/')
        if (response.status === 200) {
          logDebug(`CouchDB ready on port ${port}`)
          return true
        }
      } catch {
        // Connection failed, wait and retry
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`CouchDB did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop CouchDB server
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'couchdb.pid')

    logDebug(`Stopping CouchDB container "${name}" on port ${port}`)

    let pid: number | null = null

    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // Ignore
      }
    }

    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing CouchDB process ${pid}`)
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

    // Wait for port to be released on Windows
    if (isWindows()) {
      logDebug(`Waiting for port ${port} to be released...`)
      const portWaitStart = Date.now()
      const portWaitTimeout = 30000
      const checkInterval = 500

      while (Date.now() - portWaitStart < portWaitTimeout) {
        if (await portManager.isPortAvailable(port)) {
          logDebug('Port released successfully')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logDebug('CouchDB stopped')
  }

  // Get CouchDB server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'couchdb.pid')

    // Try health check via REST API
    try {
      const response = await couchdbApiRequest(port, 'GET', '/')
      if (response.status === 200) {
        return { running: true, message: 'CouchDB is running' }
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
            message: `CouchDB is running (PID: ${pid})`,
          }
        }
      } catch {
        // Ignore
      }
    }

    return { running: false, message: 'CouchDB is not running' }
  }

  // Detect backup format
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup
   * CouchDB can restore while running (uses REST API)
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { port } = container

    return restoreBackup(backupPath, {
      port,
      database: options.database,
      flush: options.flush,
    })
  }

  /**
   * Get connection string
   * Format: http://127.0.0.1:PORT
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const base = `http://127.0.0.1:${port}`
    return database ? `${base}/${database}` : base
  }

  // Open Fauxton web UI
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}/_utils`

    console.log(`CouchDB REST API available at: http://127.0.0.1:${port}`)
    console.log(`CouchDB Fauxton UI: ${url}`)
    console.log('')
    console.log('Example commands:')
    console.log(`  curl http://127.0.0.1:${port}`)
    console.log(`  curl http://127.0.0.1:${port}/_all_dbs`)
  }

  /**
   * Create a new database
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const response = await couchdbApiRequest(
      port,
      'PUT',
      `/${encodeURIComponent(database)}`,
    )

    if (response.status !== 201 && response.status !== 412) {
      // 412 means database already exists
      throw new Error(
        `Failed to create database: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`Created CouchDB database: ${database}`)
  }

  /**
   * Drop a database
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const response = await couchdbApiRequest(
      port,
      'DELETE',
      `/${encodeURIComponent(database)}`,
    )

    if (response.status !== 200) {
      throw new Error(
        `Failed to delete database: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`Deleted CouchDB database: ${database}`)
  }

  /**
   * Get the size of the CouchDB instance
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port } = container

    try {
      // CouchDB doesn't directly expose total size, but we can sum up database sizes
      const dbsResponse = await couchdbApiRequest(port, 'GET', '/_all_dbs')
      if (dbsResponse.status !== 200) {
        return null
      }

      const dbs = dbsResponse.data as string[]
      let totalSize = 0

      for (const db of dbs) {
        if (db.startsWith('_')) continue // Skip system dbs
        const infoResponse = await couchdbApiRequest(
          port,
          'GET',
          `/${encodeURIComponent(db)}`,
        )
        if (infoResponse.status === 200) {
          const info = infoResponse.data as { sizes?: { file?: number } }
          totalSize += info.sizes?.file || 0
        }
      }

      return totalSize > 0 ? totalSize : null
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote CouchDB connection
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const { baseUrl, headers, database } = parseCouchDBConnectionString(connectionString)

    logDebug(`Connecting to remote CouchDB at ${baseUrl}`)

    // Check connectivity
    const infoResponse = await remoteCouchDBRequest(
      baseUrl,
      'GET',
      '/',
      headers,
    )
    if (infoResponse.status !== 200) {
      throw new Error(
        `Failed to connect to CouchDB at ${baseUrl}: ${JSON.stringify(infoResponse.data)}`,
      )
    }

    const serverInfo = infoResponse.data as { version?: string }
    logDebug(`Connected to CouchDB ${serverInfo?.version || 'unknown'}`)

    // Get databases to backup
    let databasesToBackup: string[]

    if (database) {
      databasesToBackup = [database]
    } else {
      const dbsResponse = await remoteCouchDBRequest(
        baseUrl,
        'GET',
        '/_all_dbs',
        headers,
      )
      if (dbsResponse.status !== 200) {
        throw new Error(
          `Failed to list databases: ${JSON.stringify(dbsResponse.data)}`,
        )
      }
      const allDbs = dbsResponse.data as string[]
      databasesToBackup = allDbs.filter((db) => !db.startsWith('_'))
    }

    logDebug(`Backing up ${databasesToBackup.length} database(s)`)

    // Export documents from each database
    const backup = {
      version: serverInfo?.version || 'unknown',
      created: new Date().toISOString(),
      databases: [] as Array<{ name: string; docs: unknown[] }>,
    }

    for (const dbName of databasesToBackup) {
      logDebug(`Exporting database: ${dbName}`)

      const docsResponse = await remoteCouchDBRequest(
        baseUrl,
        'GET',
        `/${encodeURIComponent(dbName)}/_all_docs?include_docs=true`,
        headers,
        undefined,
        300000, // 5 minutes for large databases
      )

      if (docsResponse.status !== 200) {
        throw new Error(
          `Failed to export database ${dbName}: ${JSON.stringify(docsResponse.data)}`,
        )
      }

      const docsData = docsResponse.data as {
        rows?: Array<{ doc?: unknown }>
      }
      const docs =
        docsData.rows
          ?.map((row) => row.doc)
          .filter((doc): doc is unknown => doc !== undefined) || []

      // Filter out design documents
      const userDocs = docs.filter((doc) => {
        const d = doc as { _id?: string }
        return d._id && !d._id.startsWith('_design/')
      })

      backup.databases.push({
        name: dbName,
        docs: userDocs,
      })
    }

    // Write backup to file
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, JSON.stringify(backup, null, 2))

    return {
      filePath: outputPath,
      warnings:
        databasesToBackup.length === 0
          ? ['Remote CouchDB instance has no user databases']
          : undefined,
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

  // Run a command - CouchDB uses REST API, not command files
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container

    if (options.file) {
      throw new Error(
        'CouchDB does not support command files. Use the REST API directly.\n' +
          `Example: curl http://127.0.0.1:${port}/_all_dbs`,
      )
    }

    if (options.sql) {
      const command = options.sql.trim().toUpperCase()

      if (command === 'LIST DATABASES' || command === 'SHOW DATABASES') {
        const response = await couchdbApiRequest(port, 'GET', '/_all_dbs')
        console.log(JSON.stringify(response.data, null, 2))
        return
      }

      throw new Error(
        'CouchDB uses REST API for operations. Use curl or the CouchDB client libraries.\n' +
          `API endpoint: http://127.0.0.1:${port}`,
      )
    }

    throw new Error('Either file or sql option must be provided')
  }
}

export const couchdbEngine = new CouchDBEngine()
