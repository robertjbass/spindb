import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, openSync, closeSync } from 'fs'
import { chmod, mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  logDebug,
  logWarning,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { weaviateBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  normalizeVersion,
  SUPPORTED_MAJOR_VERSIONS,
  WEAVIATE_VERSION_MAP,
} from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { weaviateApiRequest } from './api-client'
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
import { parseRESTAPIResult } from '../../core/query-parser'

const ENGINE = 'weaviate'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Parse a Weaviate connection string
 * Supported formats:
 * - http://host:port
 * - https://host:port
 * - http://host:port?api_key=KEY (for API key auth)
 */
function parseWeaviateConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
} {
  let url: URL

  // Ensure scheme is present
  let normalized = connectionString.trim()
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `http://${normalized}`
  }

  try {
    url = new URL(normalized)
  } catch {
    // Redact query params (may contain api_key) before including in error
    const safeString = normalized.split('?')[0]
    throw new Error(
      `Invalid Weaviate connection string: ${safeString}\n` +
        'Expected format: http://host:port',
    )
  }

  // Extract API key if provided
  const apiKey = url.searchParams.get('api_key')
  const scheme = url.protocol.replace(':', '')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // Construct base URL without query params
  const port = url.port || '8080'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  return { baseUrl, headers }
}

/**
 * Make an HTTP request to a remote Weaviate server
 */
async function remoteWeaviateRequest(
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
        `Remote Weaviate request timed out after ${timeoutMs / 1000}s: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export class WeaviateEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Weaviate'
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

  // Resolves version string to full version (e.g., '1' -> '1.35.7')
  resolveFullVersion(version: string): string {
    // Check if already a full version (has at least two dots)
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }
    // It's a major version, resolve using version map
    return WEAVIATE_VERSION_MAP[version] || `${version}.0.0`
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'weaviate',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that Weaviate binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `weaviate${ext}`)
    return existsSync(serverPath)
  }

  // Check if a specific Weaviate version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return weaviateBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure Weaviate binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await weaviateBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binaries in config
    const ext = platformService.getExecutableExtension()
    const tools = ['weaviate'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * Initialize a new Weaviate data directory
   * Creates the directory structure
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

    // Create data directory if it doesn't exist
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created Weaviate data directory: ${dataDir}`)
    }

    // Create backups directory
    const backupsDir = join(dataDir, 'backups')
    if (!existsSync(backupsDir)) {
      await mkdir(backupsDir, { recursive: true })
      logDebug(`Created Weaviate backups directory: ${backupsDir}`)
    }

    // Write a config file with port info for reference
    const configPath = join(containerDir, 'weaviate.env')
    const configContent = [
      '# SpinDB generated Weaviate configuration',
      `PERSISTENCE_DATA_PATH=${dataDir}`,
      `BACKUP_FILESYSTEM_PATH=${backupsDir}`,
      `QUERY_DEFAULTS_LIMIT=25`,
      `AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true`,
      `DEFAULT_VECTORIZER_MODULE=none`,
      `CLUSTER_HOSTNAME=node1`,
      '',
    ].join('\n')
    await writeFile(configPath, configContent)
    logDebug(`Generated Weaviate config: ${configPath} (port: ${port})`)

    return dataDir
  }

  // Get the path to weaviate server for a version
  async getWeaviateServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'weaviate',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `weaviate${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Weaviate ${version} is not installed. Run: spindb engines download weaviate ${version}`,
    )
  }

  // Get the path to weaviate binary
  async getWeaviatePath(version?: string): Promise<string> {
    // Check config cache first
    const cached = await configManager.getBinaryPath('weaviate')
    if (cached && existsSync(cached)) {
      return cached
    }

    // If version provided, use downloaded binary
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'weaviate',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const weaviatePath = join(binPath, 'bin', `weaviate${ext}`)
      if (existsSync(weaviatePath)) {
        return weaviatePath
      }
    }

    throw new Error(
      'weaviate not found. Run: spindb engines download weaviate <version>',
    )
  }

  /**
   * Start Weaviate server
   * Weaviate uses environment variables for configuration
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
    let weaviateServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `weaviate${ext}`)
      if (existsSync(serverPath)) {
        weaviateServer = serverPath
        logDebug(`Using stored binary path: ${weaviateServer}`)
      }
    }

    // If we didn't find the binary above, fall back to normal path
    if (!weaviateServer) {
      try {
        weaviateServer = await this.getWeaviateServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Weaviate ${version} is not installed. Run: spindb engines download weaviate ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    logDebug(`Using weaviate for version ${version}: ${weaviateServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const backupsDir = join(dataDir, 'backups')
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'weaviate.pid')
    const grpcPort = port + 1

    // Check if gRPC port is available (Weaviate uses HTTP port + 1 for gRPC)
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckInterval = 1000

    const grpcCheckStart = Date.now()
    while (!(await portManager.isPortAvailable(grpcPort))) {
      if (Date.now() - grpcCheckStart >= portWaitTimeout) {
        throw new Error(
          `gRPC port ${grpcPort} is already in use. ` +
            `Weaviate requires both HTTP port ${port} and gRPC port ${grpcPort} to be available.`,
        )
      }
      logDebug(`Waiting for gRPC port ${grpcPort} to become available...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    // Also check HTTP port on Windows
    if (isWindows()) {
      const httpCheckStart = Date.now()
      while (!(await portManager.isPortAvailable(port))) {
        if (Date.now() - httpCheckStart >= portWaitTimeout) {
          throw new Error(
            `HTTP port ${port} is already in use. ` +
              `Weaviate requires both HTTP port ${port} and gRPC port ${grpcPort} to be available.`,
          )
        }
        logDebug(`Waiting for HTTP port ${port} to become available...`)
        await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
      }
    }

    // Ensure backups directory exists
    if (!existsSync(backupsDir)) {
      await mkdir(backupsDir, { recursive: true })
    }

    onProgress?.({ stage: 'starting', message: 'Starting Weaviate...' })

    logDebug(`Starting weaviate on port ${port}`)

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

    // Weaviate uses environment variables for configuration
    const args = [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--scheme',
      'http',
    ]

    // Derive unique internal cluster ports from the HTTP port to avoid conflicts
    // when running multiple Weaviate containers simultaneously.
    // Default internal ports (7946, 7947, 8300, 8301) are fixed and will conflict.
    const gossipPort = port + 100 // e.g., 8080 → 8180
    const dataPort = port + 101 // e.g., 8080 → 8181
    const raftPort = port + 200 // e.g., 8080 → 8280
    const raftInternalRpcPort = raftPort + 1 // e.g., 8080 → 8281

    // Read weaviate.env file (written by initDataDir and updated by createUser)
    // so that API key / auth settings persist across restarts
    const envFilePath = join(containerDir, 'weaviate.env')
    const fileEnv: Record<string, string> = {}
    if (existsSync(envFilePath)) {
      try {
        const envContent = await readFile(envFilePath, 'utf-8')
        for (const line of envContent.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eqIdx = trimmed.indexOf('=')
          if (eqIdx > 0) {
            fileEnv[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1)
          }
        }
      } catch {
        logDebug(`Could not read ${envFilePath}, using defaults`)
      }
    }

    const env = {
      ...process.env,
      // Defaults from weaviate.env file (includes auth settings from createUser)
      ...fileEnv,
      // Explicit spawn values always override file values
      PERSISTENCE_DATA_PATH: dataDir,
      BACKUP_FILESYSTEM_PATH: backupsDir,
      ENABLE_MODULES: 'backup-filesystem',
      CLUSTER_HOSTNAME: `node-${port}`,
      GRPC_PORT: String(grpcPort),
      CLUSTER_GOSSIP_BIND_PORT: String(gossipPort),
      CLUSTER_DATA_BIND_PORT: String(dataPort),
      RAFT_PORT: String(raftPort),
      RAFT_INTERNAL_RPC_PORT: String(raftInternalRpcPort),
    }

    // Redirect stdout/stderr to log file via file descriptor so
    // checkLogForError can find startup errors. File descriptors are
    // inherited by the child and don't keep Node.js event loop alive
    // (unlike 'pipe'), so proc.unref() works correctly.
    const logFd = openSync(logFile, 'a')

    const spawnOpts: SpawnOptions = {
      cwd: containerDir,
      stdio: ['ignore', logFd, logFd],
      detached: true,
      env,
    }

    if (isWindows()) {
      spawnOpts.windowsHide = true
    }

    const proc = spawn(weaviateServer, args, spawnOpts)
    proc.unref()

    // Close fd in parent — child inherited its own copy
    closeSync(logFd)

    if (!proc.pid) {
      throw new Error('Weaviate server process failed to start (no PID)')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // Non-fatal
    }

    // Wait for Weaviate to be ready
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

    const portError = await checkLogForError()

    const errorDetails = [
      portError || 'Weaviate failed to start within timeout.',
      `Binary: ${weaviateServer}`,
      `Log file: ${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  // Wait for Weaviate to be ready to accept connections
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Use Weaviate's readiness endpoint
        const response = await weaviateApiRequest(
          port,
          'GET',
          '/v1/.well-known/ready',
        )
        if (response.status === 200) {
          logDebug(`Weaviate ready on port ${port}`)
          return true
        }
      } catch {
        // Connection failed, wait and retry
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`Weaviate did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop Weaviate server
   * Uses process termination
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'weaviate.pid')
    const grpcPort = port + 1

    logDebug(`Stopping Weaviate container "${name}" on port ${port}`)

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
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing Weaviate process ${pid}`)
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

    // Wait for process to fully terminate
    const terminationWait = isWindows() ? 3000 : 1000
    await new Promise((resolve) => setTimeout(resolve, terminationWait))

    // Kill any processes still listening on the ports
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
    if (isWindows()) {
      logDebug(`Waiting for ports ${port} and ${grpcPort} to be released...`)
      const portWaitStart = Date.now()
      const portWaitTimeout = 30000
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

    logDebug('Weaviate stopped')
  }

  // Get Weaviate server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'weaviate.pid')

    // Try health check via REST API
    try {
      const response = await weaviateApiRequest(
        port,
        'GET',
        '/v1/.well-known/ready',
      )
      if (response.status === 200) {
        return { running: true, message: 'Weaviate is running' }
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
            message: `Weaviate is running (PID: ${pid})`,
          }
        }
      } catch {
        // Ignore
      }
    }

    return { running: false, message: 'Weaviate is not running' }
  }

  // Detect backup format
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup
   * IMPORTANT: Weaviate must be stopped before restore
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name } = container

    // Check if container is running - Weaviate must be stopped for snapshot restore
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `Weaviate container "${name}" must be stopped before restore. ` +
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

  // Open HTTP API (Weaviate uses REST/GraphQL API, no interactive shell)
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}`

    console.log(`Weaviate REST API available at: ${url}/v1`)
    console.log(`Weaviate GraphQL endpoint: ${url}/v1/graphql`)
    console.log(`gRPC endpoint: 127.0.0.1:${port + 1}`)
    console.log('')
    console.log('Example commands:')
    console.log(`  curl ${url}/v1/schema`)
    console.log(`  curl ${url}/v1/.well-known/ready`)
  }

  /**
   * Create a new class (collection)
   * Weaviate uses classes instead of traditional databases
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    // Create a class with default vector config
    const response = await weaviateApiRequest(port, 'POST', '/v1/schema', {
      class: database,
      vectorizer: 'none',
    })

    if (response.status !== 200) {
      throw new Error(
        `Failed to create class: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`Created Weaviate class: ${database}`)
  }

  /**
   * Drop a class
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const response = await weaviateApiRequest(
      port,
      'DELETE',
      `/v1/schema/${encodeURIComponent(database)}`,
    )

    if (response.status !== 200) {
      throw new Error(
        `Failed to delete class: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`Deleted Weaviate class: ${database}`)
  }

  /**
   * Get the storage size of the Weaviate instance
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port } = container

    try {
      await weaviateApiRequest(port, 'GET', '/v1/meta')
      // Weaviate doesn't expose direct storage size in meta
      return null
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote Weaviate connection
   * Uses Weaviate's REST API to create and download a full backup
   *
   * Connection string format: http://host:port
   * For API key auth: http://host:port?api_key=YOUR_KEY
   */
  async dumpFromConnectionString(
    connectionString: string,
    _outputPath: string,
  ): Promise<DumpResult> {
    // Parse connection string
    const { baseUrl, headers } = parseWeaviateConnectionString(connectionString)

    logDebug(`Connecting to remote Weaviate at ${baseUrl}`)

    // Check connectivity and get schema
    const schemaResponse = await remoteWeaviateRequest(
      baseUrl,
      'GET',
      '/v1/schema',
      headers,
    )
    if (schemaResponse.status !== 200) {
      throw new Error(
        `Failed to connect to Weaviate at ${baseUrl}: ${JSON.stringify(schemaResponse.data)}`,
      )
    }

    const schemaData = schemaResponse.data as {
      classes?: Array<{ class: string }>
    }
    const classCount = schemaData.classes?.length ?? 0

    logDebug(`Found ${classCount} classes on remote server`)

    // Weaviate's filesystem backup backend writes to the server's local disk
    // (BACKUP_FILESYSTEM_PATH/<backup_id>/). These files cannot be downloaded
    // over the REST API — only the backup metadata is exposed via GET.
    // To dump from a remote Weaviate instance, use an object-store backup
    // backend (s3, gcs, azure) which supports remote access.
    throw new Error(
      `Cannot dump from a remote Weaviate instance using the filesystem backup backend.\n` +
        `Weaviate filesystem backups are written to the server's local disk ` +
        `(BACKUP_FILESYSTEM_PATH/<backup_id>/) and cannot be downloaded over HTTP.\n\n` +
        `To export data from a remote Weaviate instance, either:\n` +
        `  1. SSH into the server and copy the backup directory directly\n` +
        `  2. Configure an object-store backup backend (S3, GCS, Azure) on the remote server\n` +
        `     and use the appropriate backup module endpoint instead of /v1/backups/filesystem\n` +
        `  3. Use the Weaviate client SDK to read and re-insert objects programmatically\n\n` +
        `Remote server at ${baseUrl} has ${classCount} class(es).`,
    )
  }

  // Create a backup
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  // Run a command - Weaviate uses REST/GraphQL API, not command files
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container

    if (options.file) {
      throw new Error(
        'Weaviate does not support command files. Use the REST API directly.\n' +
          `Example: curl -X GET http://127.0.0.1:${port}/v1/schema`,
      )
    }

    if (options.sql) {
      // Try to interpret as a simple command
      const command = options.sql.trim().toUpperCase()

      if (command === 'LIST CLASSES' || command === 'SHOW CLASSES') {
        const response = await weaviateApiRequest(port, 'GET', '/v1/schema')
        console.log(JSON.stringify(response.data, null, 2))
        return
      }

      throw new Error(
        'Weaviate uses REST/GraphQL API for operations. Use curl or the Weaviate client libraries.\n' +
          `API endpoint: http://127.0.0.1:${port}/v1`,
      )
    }

    throw new Error('Either file or sql option must be provided')
  }

  /**
   * Execute a query via REST API
   *
   * Query format: METHOD /path [JSON body]
   * Examples:
   *   GET /v1/schema
   *   POST /v1/graphql {"query": "{ Get { MyClass { name } } }"}
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
          'Example: GET /v1/schema',
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

    const response = await weaviateApiRequest(port, method, path, body)

    if (response.status >= 400) {
      throw new Error(
        `Weaviate API error (${response.status}): ${JSON.stringify(response.data)}`,
      )
    }

    return parseRESTAPIResult(JSON.stringify(response.data))
  }

  /**
   * List databases for Weaviate.
   * Weaviate uses classes, not databases. Returns the configured database.
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    return [container.database]
  }

  /**
   * Create/update the API key for Weaviate.
   *
   * Weaviate supports API key authentication via environment variables.
   * Calling createUser will update the config and require a restart.
   */
  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password } = options
    assertValidUsername(username)
    const { port, name } = container

    // Read current env config and add/update API key
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const configPath = join(containerDir, 'weaviate.env')

    if (!existsSync(configPath)) {
      throw new Error(
        `Weaviate config not found: ${configPath}\n` +
          `This file is created during container setup. ` +
          `Try recreating the container: spindb delete ${name} && spindb create ${name}`,
      )
    }
    const currentConfig = await readFile(configPath, 'utf-8')

    // Update or add authentication settings
    const lines = currentConfig.split('\n')
    let foundAnonAccess = false
    let foundApiKeyEnabled = false
    let foundApiKeyAllowed = false
    let foundApiKeyUsers = false

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=')) {
        lines[i] = 'AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=false'
        foundAnonAccess = true
      }
      if (lines[i].startsWith('AUTHENTICATION_APIKEY_ENABLED=')) {
        lines[i] = 'AUTHENTICATION_APIKEY_ENABLED=true'
        foundApiKeyEnabled = true
      }
      if (lines[i].startsWith('AUTHENTICATION_APIKEY_ALLOWED_KEYS=')) {
        lines[i] = `AUTHENTICATION_APIKEY_ALLOWED_KEYS=${password}`
        foundApiKeyAllowed = true
      }
      if (lines[i].startsWith('AUTHENTICATION_APIKEY_USERS=')) {
        lines[i] = `AUTHENTICATION_APIKEY_USERS=${username}`
        foundApiKeyUsers = true
      }
    }

    if (!foundAnonAccess) {
      lines.push('AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=false')
    }
    if (!foundApiKeyEnabled) {
      lines.push('AUTHENTICATION_APIKEY_ENABLED=true')
    }
    if (!foundApiKeyAllowed) {
      lines.push(`AUTHENTICATION_APIKEY_ALLOWED_KEYS=${password}`)
    }
    if (!foundApiKeyUsers) {
      lines.push(`AUTHENTICATION_APIKEY_USERS=${username}`)
    }

    const updatedConfig = lines.join('\n')

    // Only restart if the container is currently running
    const statusResult = await this.status(container)
    if (statusResult.running) {
      logWarning(
        `Restarting Weaviate container "${name}" to apply API key change. ` +
          'Active client connections will be disconnected.',
      )
      await this.stop(container)
      await writeFile(configPath, updatedConfig)
      await chmod(configPath, 0o600)
      await this.start(container)
    } else {
      await writeFile(configPath, updatedConfig)
      await chmod(configPath, 0o600)
    }

    logDebug(`Configured Weaviate API key (credential label: ${username})`)

    const connectionString = `http://127.0.0.1:${port}`

    return {
      username,
      password: '',
      connectionString,
      engine: container.engine,
      container: container.name,
      apiKey: password,
    }
  }
}

export const weaviateEngine = new WeaviateEngine()
