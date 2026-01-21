import { spawn, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
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

const ENGINE = 'qdrant'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Generate Qdrant configuration YAML content
 */
function generateQdrantConfig(options: {
  port: number
  grpcPort: number
  dataDir: string
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

log_level: INFO
`
}

/**
 * Make an HTTP request to Qdrant REST API
 */
async function qdrantApiRequest(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  const response = await fetch(url, options)
  const data = await response.json()

  return { status: response.status, data }
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

    // Generate config.yaml
    const configPath = join(containerDir, 'config.yaml')
    const configContent = generateQdrantConfig({
      port,
      grpcPort,
      dataDir,
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
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'qdrant.pid')
    const grpcPort = port + 1

    // Regenerate config with current port (in case it changed)
    const configContent = generateQdrantConfig({
      port,
      grpcPort,
      dataDir,
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
    return new Promise((resolve, reject) => {
      const spawnOpts: SpawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: isWindows(),
      }

      const args = ['--config-path', configPath]
      const proc = spawn(qdrantServer, args, spawnOpts)
      let settled = false
      let stderrOutput = ''
      let stdoutOutput = ''

      // Handle spawn errors
      proc.on('error', (err) => {
        if (settled) return
        settled = true
        reject(new Error(`Failed to spawn Qdrant server: ${err.message}`))
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

      // Detach the process
      proc.unref()

      // Give spawn a moment to fail if it's going to, then check readiness
      setTimeout(async () => {
        if (settled) return

        // Verify process actually started
        if (!proc.pid) {
          settled = true
          reject(new Error('Qdrant server process failed to start (no PID)'))
          return
        }

        // Write PID file
        try {
          await writeFile(pidFile, String(proc.pid))
        } catch {
          // Non-fatal
        }

        // Wait for Qdrant to be ready
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

  // Wait for Qdrant to be ready to accept connections
  private async waitForReady(port: number, timeoutMs = 30000): Promise<boolean> {
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
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logWarning(`Qdrant did not become ready within ${timeoutMs}ms`)
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
    if (pid && platformService.isProcessRunning(pid)) {
      logDebug(`Killing Qdrant process ${pid}`)
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
      throw new Error(`Failed to create collection: ${JSON.stringify(response.data)}`)
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
      throw new Error(`Failed to delete collection: ${JSON.stringify(response.data)}`)
    }

    logDebug(`Deleted Qdrant collection: ${database}`)
  }

  /**
   * Get the storage size of the Qdrant instance
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port } = container

    try {
      const response = await qdrantApiRequest(port, 'GET', '/telemetry')
      const data = response.data as {
        result?: { app?: { collections_count?: number } }
      }
      // Qdrant doesn't expose direct storage size in telemetry
      // Return null as we can't determine exact size
      return null
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote Qdrant connection
   * Qdrant doesn't support remote dump like pg_dump
   */
  async dumpFromConnectionString(
    _connectionString: string,
    _outputPath: string,
  ): Promise<DumpResult> {
    throw new Error(
      'Qdrant does not support creating containers from remote connection strings.\n' +
        'To migrate data from a remote Qdrant instance:\n' +
        '  1. Create a snapshot on the remote server via REST API\n' +
        '  2. Download the snapshot file\n' +
        '  3. spindb restore <container> snapshot.snapshot',
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
}

export const qdrantEngine = new QdrantEngine()
