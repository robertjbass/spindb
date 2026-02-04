import { spawn, type SpawnOptions } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { qdrantBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  QDRANT_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { qdrantApiRequest } from './api-client'
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
import { parseRESTAPIResult } from '../../core/query-parser'

const ENGINE = 'qdrant'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Generate Qdrant configuration YAML content
 */
function generateQdrantConfig(options: {
  port: number
  grpcPort: number
  dataDir: string
  snapshotsDir: string
}): string {
  // Qdrant config uses forward slashes even on Windows
  const normalizePathForQdrant = (p: string) => p.replace(/\\/g, '/')

  return `# SpinDB generated Qdrant configuration
service:
  host: 127.0.0.1
  http_port: ${options.port}
  grpc_port: ${options.grpcPort}

storage:
  storage_path: ${normalizePathForQdrant(options.dataDir)}
  snapshots_path: ${normalizePathForQdrant(options.snapshotsDir)}

log_level: INFO
`
}

/**
 * Parse a Qdrant connection string
 * Supported formats:
 * - http://host:port
 * - https://host:port
 * - qdrant://host:port (converted to http)
 * - http://host:port?api_key=KEY (for API key auth)
 */
function parseQdrantConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
} {
  let url: URL
  let scheme = 'http'

  // Handle qdrant:// scheme by converting to http://
  let normalized = connectionString.trim()
  if (normalized.startsWith('qdrant://')) {
    normalized = normalized.replace('qdrant://', 'http://')
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
      `Invalid Qdrant connection string: ${connectionString}\n` +
        'Expected format: http://host:port or qdrant://host:port',
    )
  }

  // Extract API key if provided
  const apiKey = url.searchParams.get('api_key')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey) {
    headers['api-key'] = apiKey
  }

  // Construct base URL without query params
  // Qdrant REST API uses port 6333 regardless of http/https
  const port = url.port || '6333'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  return { baseUrl, headers }
}

/**
 * Make an HTTP request to a remote Qdrant server
 */
async function remoteQdrantRequest(
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

    // Try to parse as JSON, fall back to text
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
        `Remote Qdrant request timed out after ${timeoutMs / 1000}s: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export class QdrantEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Qdrant'
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

  // Resolves version string to full version (e.g., '1' -> '1.16.3')
  resolveFullVersion(version: string): string {
    // Check if already a full version (has at least two dots)
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // It's a major version, resolve using version map
    return QDRANT_VERSION_MAP[version] || `${version}.0.0`
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'qdrant',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that Qdrant binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `qdrant${ext}`)
    return existsSync(serverPath)
  }

  // Check if a specific Qdrant version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return qdrantBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure Qdrant binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await qdrantBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binaries in config
    const ext = platformService.getExecutableExtension()
    const tools = ['qdrant'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * Initialize a new Qdrant data directory
   * Creates the directory and generates config.yaml
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
    const grpcPort = port + 1 // gRPC port is typically HTTP port + 1

    // Create data directory if it doesn't exist
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created Qdrant data directory: ${dataDir}`)
    }

    // Create snapshots directory
    const snapshotsDir = join(dataDir, 'snapshots')
    if (!existsSync(snapshotsDir)) {
      await mkdir(snapshotsDir, { recursive: true })
      logDebug(`Created Qdrant snapshots directory: ${snapshotsDir}`)
    }

    // Generate config.yaml
    const configPath = join(containerDir, 'config.yaml')
    const configContent = generateQdrantConfig({
      port,
      grpcPort,
      dataDir,
      snapshotsDir,
    })
    await writeFile(configPath, configContent)
    logDebug(`Generated Qdrant config: ${configPath}`)

    return dataDir
  }

  // Get the path to qdrant server for a version
  async getQdrantServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'qdrant',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `qdrant${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Qdrant ${version} is not installed. Run: spindb engines download qdrant ${version}`,
    )
  }

  // Get the path to qdrant binary
  async getQdrantPath(version?: string): Promise<string> {
    // Check config cache first
    const cached = await configManager.getBinaryPath('qdrant')
    if (cached && existsSync(cached)) {
      return cached
    }

    // If version provided, use downloaded binary
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'qdrant',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const qdrantPath = join(binPath, 'bin', `qdrant${ext}`)
      if (existsSync(qdrantPath)) {
        return qdrantPath
      }
    }

    throw new Error(
      'qdrant not found. Run: spindb engines download qdrant <version>',
    )
  }

  /**
   * Start Qdrant server
   * CLI wrapper: qdrant --config-path /path/to/config.yaml
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
    let qdrantServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `qdrant${ext}`)
      if (existsSync(serverPath)) {
        qdrantServer = serverPath
        logDebug(`Using stored binary path: ${qdrantServer}`)
      }
    }

    // If we didn't find the binary above, fall back to normal path
    if (!qdrantServer) {
      try {
        qdrantServer = await this.getQdrantServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Qdrant ${version} is not installed. Run: spindb engines download qdrant ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    logDebug(`Using qdrant for version ${version}: ${qdrantServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'config.yaml')
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const snapshotsDir = join(dataDir, 'snapshots')
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'qdrant.pid')
    const grpcPort = port + 1

    // Check if gRPC port is available (Qdrant uses HTTP port + 1 for gRPC)
    // On Windows, wait longer for ports to be released (TIME_WAIT state can persist)
    // Windows can hold ports for 30+ seconds after process termination
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckStart = Date.now()
    const portCheckInterval = 1000

    while (!(await portManager.isPortAvailable(grpcPort))) {
      if (Date.now() - portCheckStart >= portWaitTimeout) {
        throw new Error(
          `gRPC port ${grpcPort} is already in use. ` +
            `Qdrant requires both HTTP port ${port} and gRPC port ${grpcPort} to be available.`,
        )
      }
      logDebug(`Waiting for gRPC port ${grpcPort} to become available...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    // Also check HTTP port on Windows
    if (isWindows()) {
      while (!(await portManager.isPortAvailable(port))) {
        if (Date.now() - portCheckStart >= portWaitTimeout) {
          throw new Error(
            `HTTP port ${port} is already in use. ` +
              `Qdrant requires both HTTP port ${port} and gRPC port ${grpcPort} to be available.`,
          )
        }
        logDebug(`Waiting for HTTP port ${port} to become available...`)
        await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
      }
    }

    // Ensure snapshots directory exists
    if (!existsSync(snapshotsDir)) {
      await mkdir(snapshotsDir, { recursive: true })
    }

    // Regenerate config with current port (in case it changed)
    const configContent = generateQdrantConfig({
      port,
      grpcPort,
      dataDir,
      snapshotsDir,
    })
    await writeFile(configPath, configContent)

    onProgress?.({ stage: 'starting', message: 'Starting Qdrant...' })

    logDebug(`Starting qdrant with config: ${configPath}`)

    /**
     * Check log file for startup errors
     */
    const checkLogForError = async (): Promise<string | null> => {
      try {
        const logContent = await readFile(logFile, 'utf-8')
        const recentLog = logContent.slice(-2000) // Last 2KB

        if (
          recentLog.includes('Address already in use') ||
          recentLog.includes('bind: Address already in use')
        ) {
          return `Port ${port} is already in use`
        }
        if (recentLog.includes('Failed to bind')) {
          return `Port ${port} is already in use`
        }
      } catch {
        // Log file might not exist yet
      }
      return null
    }

    // Qdrant runs in foreground, so we need to spawn detached
    // Set cwd to container directory so any files Qdrant creates stay there
    const args = ['--config-path', configPath]

    // On non-Windows, use 'ignore' for stdio to allow Node.js process to exit
    // (piped streams keep the event loop alive even after unref)
    // On Windows, use 'pipe' to capture stderr for better error messages
    if (isWindows()) {
      return new Promise((resolve, reject) => {
        const spawnOpts: SpawnOptions = {
          cwd: containerDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
        }

        const proc = spawn(qdrantServer, args, spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`Failed to spawn Qdrant server: ${err.message}`))
        })

        proc.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          const reason = signal ? `signal ${signal}` : `code ${code}`
          reject(
            new Error(
              `Qdrant process exited unexpectedly (${reason}).\n` +
                `Stderr: ${stderrOutput || '(none)'}\n` +
                `Stdout: ${stdoutOutput || '(none)'}`,
            ),
          )
        })

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          stdoutOutput += str
          logDebug(`qdrant stdout: ${str}`)
        })
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          stderrOutput += str
          logDebug(`qdrant stderr: ${str}`)
        })

        proc.unref()

        setTimeout(async () => {
          if (settled) return

          if (!proc.pid) {
            settled = true
            reject(new Error('Qdrant server process failed to start (no PID)'))
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

            // Clean up the orphaned detached process before rejecting
            if (proc.pid && platformService.isProcessRunning(proc.pid)) {
              try {
                await platformService.terminateProcess(proc.pid, true)
              } catch {
                // Ignore cleanup errors - best effort
              }
            }

            const portError = await checkLogForError()

            const errorDetails = [
              portError || 'Qdrant failed to start within timeout.',
              `Binary: ${qdrantServer}`,
              `Config: ${configPath}`,
              `Log file: ${logFile}`,
              stderrOutput ? `Stderr:\n${stderrOutput}` : '',
              stdoutOutput ? `Stdout:\n${stdoutOutput}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        }, 500)
      })
    }

    // macOS/Linux: spawn with ignored stdio so Node.js can exit cleanly
    const proc = spawn(qdrantServer, args, {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    proc.unref()

    if (!proc.pid) {
      throw new Error('Qdrant server process failed to start (no PID)')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // Non-fatal
    }

    // Wait for Qdrant to be ready
    const ready = await this.waitForReady(port)

    if (ready) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    const portError = await checkLogForError()

    const errorDetails = [
      portError || 'Qdrant failed to start within timeout.',
      `Binary: ${qdrantServer}`,
      `Config: ${configPath}`,
      `Log file: ${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  // Wait for Qdrant to be ready to accept connections
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Use REST API health check
        const response = await qdrantApiRequest(port, 'GET', '/healthz')
        if (response.status === 200) {
          logDebug(`Qdrant ready on port ${port}`)
          return true
        }
      } catch {
        // Connection failed, wait and retry
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`Qdrant did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop Qdrant server
   * Uses process termination
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'qdrant.pid')
    const grpcPort = port + 1

    logDebug(`Stopping Qdrant container "${name}" on port ${port}`)

    // Get PID and terminate
    let pid: number | null = null

    if (existsSync(pidFile)) {
      try {
        const content = await readFile(pidFile, 'utf8')
        pid = parseInt(content.trim(), 10)
      } catch {
        // Ignore
      }
    }

    // Kill process if running
    // On Windows, use force kill immediately (graceful shutdown often doesn't release resources)
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing Qdrant process ${pid}`)
      try {
        // On Windows, skip graceful termination - it often doesn't release file handles
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

    // Wait for process to fully terminate
    // Windows needs longer due to file handle release
    // Linux/macOS need a brief wait after SIGKILL before checking ports
    const terminationWait = isWindows() ? 3000 : 1000
    await new Promise((resolve) => setTimeout(resolve, terminationWait))

    // Kill any processes still listening on the ports
    // This handles cases where the PID file is stale, child processes exist,
    // or the main process termination didn't work
    const portPids = await platformService.findProcessByPort(port)
    const grpcPids = await platformService.findProcessByPort(grpcPort)
    const allPids = [...new Set([...portPids, ...grpcPids])]
    for (const portPid of allPids) {
      if (platformService.isProcessRunning(portPid)) {
        logDebug(`Killing process ${portPid} still on port ${port}/${grpcPort}`)
        try {
          await platformService.terminateProcess(portPid, true)
        } catch {
          // Ignore
        }
      }
    }

    // On Windows, wait again after killing port processes
    if (isWindows() && allPids.length > 0) {
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

    // On Windows, wait for ports to be released
    // Windows holds onto ports longer after process termination (TIME_WAIT state)
    // Can take 30+ seconds in some cases
    if (isWindows()) {
      logDebug(`Waiting for ports ${port} and ${grpcPort} to be released...`)
      const portWaitStart = Date.now()
      const portWaitTimeout = 30000 // 30 seconds max
      const checkInterval = 500

      while (Date.now() - portWaitStart < portWaitTimeout) {
        const httpAvailable = await portManager.isPortAvailable(port)
        const grpcAvailable = await portManager.isPortAvailable(grpcPort)

        if (httpAvailable && grpcAvailable) {
          logDebug('Ports released successfully')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logDebug('Qdrant stopped')
  }

  // Get Qdrant server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'qdrant.pid')

    // Try health check via REST API
    try {
      const response = await qdrantApiRequest(port, 'GET', '/healthz')
      if (response.status === 200) {
        return { running: true, message: 'Qdrant is running' }
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
            message: `Qdrant is running (PID: ${pid})`,
          }
        }
      } catch {
        // Ignore
      }
    }

    return { running: false, message: 'Qdrant is not running' }
  }

  // Detect backup format
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup
   * IMPORTANT: Qdrant must be stopped before restore
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name } = container

    // Check if container is running - Qdrant must be stopped for snapshot restore
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `Qdrant container "${name}" must be stopped before restore. ` +
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
   * Get connection string
   * Format: http://127.0.0.1:PORT
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    const { port } = container
    return `http://127.0.0.1:${port}`
  }

  // Open HTTP API (Qdrant uses REST API, no interactive shell)
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}/dashboard`

    console.log(`Qdrant REST API available at: http://127.0.0.1:${port}`)
    console.log(`Qdrant Dashboard: ${url}`)
    console.log(`gRPC endpoint: http://127.0.0.1:${port + 1}`)
    console.log('')
    console.log('Example commands:')
    console.log(`  curl http://127.0.0.1:${port}/collections`)
    console.log(`  curl http://127.0.0.1:${port}/healthz`)
  }

  /**
   * Create a new collection
   * Qdrant uses collections instead of traditional databases
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    // Create a collection with default vector config
    // Users will need to configure proper vector dimensions for their use case
    const response = await qdrantApiRequest(
      port,
      'PUT',
      `/collections/${database}`,
      {
        vectors: {
          size: 128, // Default vector size, user should update for their needs
          distance: 'Cosine',
        },
      },
    )

    if (response.status !== 200) {
      throw new Error(
        `Failed to create collection: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`Created Qdrant collection: ${database}`)
  }

  /**
   * Drop a collection
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const response = await qdrantApiRequest(
      port,
      'DELETE',
      `/collections/${database}`,
    )

    if (response.status !== 200) {
      throw new Error(
        `Failed to delete collection: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`Deleted Qdrant collection: ${database}`)
  }

  /**
   * Get the storage size of the Qdrant instance
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port } = container

    try {
      // Make API call to verify connectivity, but Qdrant doesn't expose storage size
      await qdrantApiRequest(port, 'GET', '/telemetry')
      // Qdrant doesn't expose direct storage size in telemetry
      // Return null as we can't determine exact size
      return null
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote Qdrant connection
   * Uses Qdrant's REST API to create and download a full snapshot
   *
   * Connection string format: http://host:port or qdrant://host:port
   * For API key auth: http://host:port?api_key=YOUR_KEY
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // Parse connection string
    const { baseUrl, headers } = parseQdrantConnectionString(connectionString)

    logDebug(`Connecting to remote Qdrant at ${baseUrl}`)

    // Check connectivity and get collection count
    const collectionsResponse = await remoteQdrantRequest(
      baseUrl,
      'GET',
      '/collections',
      headers,
    )
    if (collectionsResponse.status !== 200) {
      throw new Error(
        `Failed to connect to Qdrant at ${baseUrl}: ${JSON.stringify(collectionsResponse.data)}`,
      )
    }

    const collectionsData = collectionsResponse.data as {
      result?: { collections?: Array<{ name: string }> }
    }
    const collectionCount = collectionsData.result?.collections?.length ?? 0

    logDebug(`Found ${collectionCount} collections on remote server`)

    // Create a full snapshot on the remote server
    logDebug('Creating snapshot on remote server...')
    const snapshotResponse = await remoteQdrantRequest(
      baseUrl,
      'POST',
      '/snapshots',
      headers,
    )

    if (snapshotResponse.status !== 200) {
      throw new Error(
        `Failed to create snapshot on remote Qdrant: ${JSON.stringify(snapshotResponse.data)}`,
      )
    }

    const snapshotData = snapshotResponse.data as { result?: { name?: string } }
    const snapshotName = snapshotData.result?.name

    if (!snapshotName) {
      throw new Error(
        'Qdrant snapshot creation failed: no snapshot name returned',
      )
    }

    logDebug(`Remote snapshot created: ${snapshotName}`)

    // Download the snapshot with timeout (5 minutes for large snapshots)
    const snapshotUrl = `${baseUrl}/snapshots/${snapshotName}`
    logDebug(`Downloading snapshot from ${snapshotUrl}...`)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000)

    let downloadResponse: Response
    try {
      downloadResponse = await fetch(snapshotUrl, {
        headers,
        signal: controller.signal,
      })
    } catch (fetchError) {
      clearTimeout(timeoutId)
      // Clean up the snapshot we created
      await fetch(`${snapshotUrl}`, { method: 'DELETE', headers }).catch(
        () => {},
      )
      const err = fetchError as Error
      if (err.name === 'AbortError') {
        throw new Error('Snapshot download timed out after 5 minutes')
      }
      throw fetchError
    }

    if (!downloadResponse.ok) {
      clearTimeout(timeoutId)
      // Clean up the snapshot we created
      await fetch(`${snapshotUrl}`, { method: 'DELETE', headers }).catch(
        () => {},
      )
      throw new Error(
        `Failed to download snapshot: ${downloadResponse.status} ${downloadResponse.statusText}`,
      )
    }

    // Stream to output path instead of buffering in memory
    if (!downloadResponse.body) {
      clearTimeout(timeoutId)
      throw new Error('Download failed: response has no body')
    }

    const fileStream = createWriteStream(outputPath)
    try {
      const nodeStream = Readable.fromWeb(downloadResponse.body)
      await pipeline(nodeStream, fileStream)
      clearTimeout(timeoutId)
    } catch (streamError) {
      clearTimeout(timeoutId)
      fileStream.destroy()
      // Remove partial output file
      await unlink(outputPath).catch(() => {})
      // Clean up the snapshot on remote server
      await fetch(`${snapshotUrl}`, { method: 'DELETE', headers }).catch(
        () => {},
      )
      throw streamError
    }

    logDebug(`Snapshot downloaded to ${outputPath}`)

    // Clean up snapshot on remote server (courtesy cleanup)
    await fetch(`${snapshotUrl}`, { method: 'DELETE', headers }).catch(
      (err) => {
        logDebug(`Could not delete remote snapshot (non-fatal): ${err}`)
      },
    )

    return {
      filePath: outputPath,
      warnings:
        collectionCount === 0
          ? ['Remote Qdrant instance has no collections']
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

  // Run a command - Qdrant uses REST API, not command files
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container

    if (options.file) {
      throw new Error(
        'Qdrant does not support command files. Use the REST API directly.\n' +
          `Example: curl -X POST http://127.0.0.1:${port}/collections`,
      )
    }

    if (options.sql) {
      // Try to interpret as a simple command (e.g., "LIST COLLECTIONS")
      const command = options.sql.trim().toUpperCase()

      if (command === 'LIST COLLECTIONS' || command === 'SHOW COLLECTIONS') {
        const response = await qdrantApiRequest(port, 'GET', '/collections')
        console.log(JSON.stringify(response.data, null, 2))
        return
      }

      throw new Error(
        'Qdrant uses REST API for operations. Use curl or the Qdrant client libraries.\n' +
          `API endpoint: http://127.0.0.1:${port}`,
      )
    }

    throw new Error('Either file or sql option must be provided')
  }

  /**
   * Execute a query via REST API
   *
   * Query format: METHOD /path [JSON body]
   * Examples:
   *   GET /collections
   *   POST /collections/my_collection/points/search {"vector": [0.1, 0.2], "limit": 10}
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container

    // Parse the query string: METHOD /path [body]
    const trimmed = query.trim()
    const spaceIdx = trimmed.indexOf(' ')

    if (spaceIdx === -1) {
      throw new Error(
        'Invalid query format. Expected: METHOD /path [body]\n' +
          'Example: GET /collections',
      )
    }

    const method = (options?.method ||
      trimmed.substring(0, spaceIdx).toUpperCase()) as
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'DELETE'
    const rest = trimmed.substring(spaceIdx + 1).trim()

    // Extract path and optional JSON body
    let path: string
    let body: Record<string, unknown> | undefined = options?.body

    const bodyStart = rest.indexOf('{')
    if (bodyStart !== -1) {
      // Always extract path without the JSON blob
      path = rest.substring(0, bodyStart).trim()
      if (options?.body) {
        // Both inline JSON and options.body provided - error
        throw new Error(
          'Cannot specify both inline JSON body in query and options.body. Use one or the other.',
        )
      }
      try {
        body = JSON.parse(rest.substring(bodyStart)) as Record<string, unknown>
      } catch {
        throw new Error('Invalid JSON body in query')
      }
    } else {
      path = rest
    }

    // Ensure path starts with /
    if (!path.startsWith('/')) {
      path = '/' + path
    }

    const response = await qdrantApiRequest(port, method, path, body)

    if (response.status >= 400) {
      throw new Error(
        `Qdrant API error (${response.status}): ${JSON.stringify(response.data)}`,
      )
    }

    return parseRESTAPIResult(JSON.stringify(response.data))
  }
}

export const qdrantEngine = new QdrantEngine()
