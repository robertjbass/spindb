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
import { portManager } from '../../core/port-manager'
import { meilisearchBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { meilisearchApiRequest } from './api-client'
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

const ENGINE = 'meilisearch'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Initial delay before checking if Meilisearch is ready after spawning.
 * Windows requires a longer delay as process startup is slower.
 */
const START_CHECK_DELAY_MS = isWindows() ? 2000 : 500

/**
 * Parse a Meilisearch connection string
 * Supported formats:
 * - http://host:port
 * - https://host:port
 * - meilisearch://host:port (converted to http)
 * - http://host:port?api_key=KEY (for API key auth)
 */
function parseMeilisearchConnectionString(connectionString: string): {
  baseUrl: string
  headers: Record<string, string>
} {
  let url: URL
  let scheme = 'http'

  // Handle meilisearch:// scheme by converting to http://
  let normalized = connectionString.trim()
  if (normalized.startsWith('meilisearch://')) {
    normalized = normalized.replace('meilisearch://', 'http://')
  }

  // Ensure scheme is present
  if (
    !normalized.startsWith('http://') &&
    !normalized.startsWith('https://')
  ) {
    normalized = `http://${normalized}`
  }

  try {
    url = new URL(normalized)
    scheme = url.protocol.replace(':', '')
  } catch {
    throw new Error(
      `Invalid Meilisearch connection string: ${connectionString}\n` +
        'Expected format: http://host:port or meilisearch://host:port',
    )
  }

  // Extract API key if provided
  const apiKey = url.searchParams.get('api_key')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // Construct base URL without query params
  const port = url.port || '7700'
  const baseUrl = `${scheme}://${url.hostname}:${port}`

  return { baseUrl, headers }
}

/**
 * Make an HTTP request to a remote Meilisearch server
 */
async function remoteMeilisearchRequest(
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
        `Remote Meilisearch request timed out after ${timeoutMs / 1000}s: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export class MeilisearchEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Meilisearch'
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

  // Resolves version string to full version (e.g., '1' -> '1.33.1')
  resolveFullVersion(version: string): string {
    // Use normalizeVersion which handles all cases:
    // - Maps known versions (1 -> 1.33.1, 1.33 -> 1.33.1)
    // - Returns full versions as-is (1.33.1 -> 1.33.1)
    // - Returns unknown versions as-is with a warning (avoids invalid 4-part versions)
    return normalizeVersion(version)
  }

  // Get the path where binaries for a version would be installed
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'meilisearch',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  // Verify that Meilisearch binaries are available
  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `meilisearch${ext}`)
    return existsSync(serverPath)
  }

  // Check if a specific Meilisearch version is installed (downloaded)
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return meilisearchBinaryManager.isInstalled(version, platform, arch)
  }

  /**
   * Ensure Meilisearch binaries are available for a specific version
   * Downloads from hostdb if not already installed
   * Returns the path to the bin directory
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await meilisearchBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register binaries in config
    const ext = platformService.getExecutableExtension()
    const tools = ['meilisearch'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  /**
   * Initialize a new Meilisearch data directory
   * Creates the directory structure
   *
   * IMPORTANT: snapshots directory must be a SIBLING of data directory, not inside it.
   * Meilisearch fails to start if --snapshot-dir points inside --db-path.
   */
  async initDataDir(
    containerName: string,
    _version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })
    const containerDir = paths.getContainerPath(containerName, {
      engine: ENGINE,
    })

    // Create container directory if it doesn't exist
    if (!existsSync(containerDir)) {
      await mkdir(containerDir, { recursive: true })
    }

    // Create data directory if it doesn't exist
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created Meilisearch data directory: ${dataDir}`)
    }

    // Create snapshots directory as SIBLING of data (not inside it!)
    // Meilisearch fails with "failed to infer the version of the database"
    // if --snapshot-dir points inside --db-path
    const snapshotsDir = join(containerDir, 'snapshots')
    if (!existsSync(snapshotsDir)) {
      await mkdir(snapshotsDir, { recursive: true })
      logDebug(`Created Meilisearch snapshots directory: ${snapshotsDir}`)
    }

    return dataDir
  }

  // Get the path to meilisearch server for a version
  async getMeilisearchServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'meilisearch',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `meilisearch${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `Meilisearch ${version} is not installed. Run: spindb engines download meilisearch ${version}`,
    )
  }

  // Get the path to meilisearch binary
  async getMeilisearchPath(version?: string): Promise<string> {
    // Check config cache first
    const cached = await configManager.getBinaryPath('meilisearch')
    if (cached && existsSync(cached)) {
      return cached
    }

    // If version provided, use downloaded binary
    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'meilisearch',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const meilisearchPath = join(binPath, 'bin', `meilisearch${ext}`)
      if (existsSync(meilisearchPath)) {
        return meilisearchPath
      }
    }

    throw new Error(
      'meilisearch not found. Run: spindb engines download meilisearch <version>',
    )
  }

  /**
   * Start Meilisearch server
   * CLI: meilisearch --db-path /path/to/data --http-addr 127.0.0.1:PORT --env development
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
    let meilisearchServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `meilisearch${ext}`)
      if (existsSync(serverPath)) {
        meilisearchServer = serverPath
        logDebug(`Using stored binary path: ${meilisearchServer}`)
      }
    }

    // If we didn't find the binary above, fall back to normal path
    if (!meilisearchServer) {
      try {
        meilisearchServer = await this.getMeilisearchServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `Meilisearch ${version} is not installed. Run: spindb engines download meilisearch ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    logDebug(`Using meilisearch for version ${version}: ${meilisearchServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    // IMPORTANT: snapshots must be a SIBLING of data, not inside it
    // Meilisearch fails with "failed to infer database version" if --snapshot-dir is inside --db-path
    const snapshotsDir = join(containerDir, 'snapshots')
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'meilisearch.pid')

    // On Windows, wait longer for ports to be released (TIME_WAIT state can persist)
    const portWaitTimeout = isWindows() ? 60000 : 0
    const portCheckStart = Date.now()
    const portCheckInterval = 1000

    // Check if HTTP port is available
    while (!(await portManager.isPortAvailable(port))) {
      if (Date.now() - portCheckStart >= portWaitTimeout) {
        throw new Error(`HTTP port ${port} is already in use.`)
      }
      logDebug(`Waiting for HTTP port ${port} to become available...`)
      await new Promise((resolve) => setTimeout(resolve, portCheckInterval))
    }

    // Ensure snapshots directory exists
    if (!existsSync(snapshotsDir)) {
      await mkdir(snapshotsDir, { recursive: true })
    }

    // Check for pending snapshot import (created by restore operation)
    const importMarkerPath = join(containerDir, 'pending-snapshot-import')
    let pendingSnapshotImport: string | null = null
    if (existsSync(importMarkerPath)) {
      try {
        pendingSnapshotImport = (await readFile(importMarkerPath, 'utf-8')).trim()
        logDebug(`Found pending snapshot import: ${pendingSnapshotImport}`)
      } catch {
        logDebug('Failed to read pending snapshot import marker')
      }
    }

    onProgress?.({ stage: 'starting', message: 'Starting Meilisearch...' })

    // Build command arguments
    // Meilisearch uses --db-path for data directory and --http-addr for binding
    const args = [
      '--db-path',
      dataDir,
      '--http-addr',
      `127.0.0.1:${port}`,
      '--env',
      'development',
      '--no-analytics',
      '--snapshot-dir',
      snapshotsDir,
    ]

    // If there's a pending snapshot import, add the flag
    if (pendingSnapshotImport && existsSync(pendingSnapshotImport)) {
      args.push('--import-snapshot', pendingSnapshotImport)
      logDebug(`Will import snapshot: ${pendingSnapshotImport}`)
    }

    logDebug(`Starting meilisearch with args: ${args.join(' ')}`)

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

    // Meilisearch runs in foreground, so we need to spawn detached
    if (isWindows()) {
      return new Promise((resolve, reject) => {
        const spawnOpts: SpawnOptions = {
          cwd: containerDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
        }

        const proc = spawn(meilisearchServer, args, spawnOpts)
        let settled = false
        let stderrOutput = ''
        let stdoutOutput = ''

        proc.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`Failed to spawn Meilisearch server: ${err.message}`))
        })

        proc.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          const reason = signal ? `signal ${signal}` : `code ${code}`
          reject(
            new Error(
              `Meilisearch process exited unexpectedly (${reason}).\n` +
                `Stderr: ${stderrOutput || '(none)'}\n` +
                `Stdout: ${stdoutOutput || '(none)'}`,
            ),
          )
        })

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          stdoutOutput += str
          logDebug(`meilisearch stdout: ${str}`)
        })
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          stderrOutput += str
          logDebug(`meilisearch stderr: ${str}`)
        })

        proc.unref()

        setTimeout(async () => {
          if (settled) return

          if (!proc.pid) {
            settled = true
            reject(
              new Error('Meilisearch server process failed to start (no PID)'),
            )
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
            // Clean up pending snapshot import marker if it exists
            if (existsSync(importMarkerPath)) {
              try {
                await unlink(importMarkerPath)
                logDebug('Cleaned up pending snapshot import marker')
              } catch {
                // Non-fatal
              }
            }
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
              portError || 'Meilisearch failed to start within timeout.',
              `Binary: ${meilisearchServer}`,
              `Log file: ${logFile}`,
              stderrOutput ? `Stderr:\n${stderrOutput}` : '',
              stdoutOutput ? `Stdout:\n${stdoutOutput}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            reject(new Error(errorDetails))
          }
        }, START_CHECK_DELAY_MS)
      })
    }

    // macOS/Linux: spawn with ignored stdio so Node.js can exit cleanly
    const proc = spawn(meilisearchServer, args, {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    proc.unref()

    if (!proc.pid) {
      throw new Error('Meilisearch server process failed to start (no PID)')
    }

    try {
      await writeFile(pidFile, String(proc.pid))
    } catch {
      // Non-fatal
    }

    // Wait for Meilisearch to be ready
    const ready = await this.waitForReady(port)

    if (ready) {
      // Clean up pending snapshot import marker if it exists
      if (existsSync(importMarkerPath)) {
        try {
          await unlink(importMarkerPath)
          logDebug('Cleaned up pending snapshot import marker')
        } catch {
          // Non-fatal
        }
      }
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // Clean up the orphaned detached process before throwing
    if (proc.pid) {
      try {
        // Try to kill the process group first (POSIX)
        process.kill(-proc.pid, 'SIGTERM')
        logDebug(`Killed process group ${proc.pid}`)
      } catch {
        // Process group kill failed, try individual process
        try {
          process.kill(proc.pid, 'SIGTERM')
          logDebug(`Killed process ${proc.pid}`)
        } catch {
          // Ignore - process may have already exited
        }
      }
    }

    // Clean up PID file
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // Non-fatal
      }
    }

    const portError = await checkLogForError()

    const errorDetails = [
      portError || 'Meilisearch failed to start within timeout.',
      `Binary: ${meilisearchServer}`,
      `Log file: ${logFile}`,
    ]
      .filter(Boolean)
      .join('\n')

    throw new Error(errorDetails)
  }

  // Wait for Meilisearch to be ready to accept connections
  private async waitForReady(
    port: number,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Use REST API health check
        // Meilisearch uses /health (not /healthz like Qdrant)
        const response = await meilisearchApiRequest(port, 'GET', '/health')
        if (response.status === 200) {
          logDebug(`Meilisearch ready on port ${port}`)
          return true
        }
      } catch {
        // Connection failed, wait and retry
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    logDebug(`Meilisearch did not become ready within ${timeoutMs}ms`)
    return false
  }

  /**
   * Stop Meilisearch server
   * Uses process termination
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'meilisearch.pid')

    logDebug(`Stopping Meilisearch container "${name}" on port ${port}`)

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
      logDebug(`Killing Meilisearch process ${pid}`)
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

    // On Windows, wait again after killing port processes
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

    // On Windows, wait for ports to be released
    if (isWindows()) {
      logDebug(`Waiting for port ${port} to be released...`)
      const portWaitStart = Date.now()
      const portWaitTimeout = 30000 // 30 seconds max
      const checkInterval = 500

      while (Date.now() - portWaitStart < portWaitTimeout) {
        const httpAvailable = await portManager.isPortAvailable(port)

        if (httpAvailable) {
          logDebug('Port released successfully')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    }

    logDebug('Meilisearch stopped')
  }

  // Get Meilisearch server status
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'meilisearch.pid')

    // Try health check via REST API
    try {
      const response = await meilisearchApiRequest(port, 'GET', '/health')
      if (response.status === 200) {
        return { running: true, message: 'Meilisearch is running' }
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
            message: `Meilisearch is running (PID: ${pid})`,
          }
        }
      } catch {
        // Ignore
      }
    }

    return { running: false, message: 'Meilisearch is not running' }
  }

  // Detect backup format
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup
   * IMPORTANT: Meilisearch must be stopped before restore
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options: { database?: string; flush?: boolean } = {},
  ): Promise<RestoreResult> {
    const { name } = container

    // Check if container is running - Meilisearch must be stopped for snapshot restore
    const statusResult = await this.status(container)
    if (statusResult.running) {
      throw new Error(
        `Meilisearch container "${name}" must be stopped before restore. ` +
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

  // Open HTTP API (Meilisearch uses REST API, no interactive shell)
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { port } = container
    const url = `http://127.0.0.1:${port}`

    console.log(`Meilisearch REST API available at: ${url}`)
    console.log(`Meilisearch Dashboard: ${url}`)
    console.log('')
    console.log('Example commands:')
    console.log(`  curl ${url}/indexes`)
    console.log(`  curl ${url}/health`)
    console.log(`  curl ${url}/stats`)
  }

  /**
   * Create a new index
   * Meilisearch uses indexes instead of traditional databases
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    // Create an index with the given name as the primary key
    const response = await meilisearchApiRequest(port, 'POST', '/indexes', {
      uid: database,
      primaryKey: 'id',
    })

    // Meilisearch returns 202 Accepted for async operations
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(
        `Failed to create index: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`Created Meilisearch index: ${database}`)
  }

  /**
   * Drop an index
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const response = await meilisearchApiRequest(
      port,
      'DELETE',
      `/indexes/${database}`,
    )

    // Meilisearch returns 202 Accepted for async delete
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(
        `Failed to delete index: ${JSON.stringify(response.data)}`,
      )
    }

    logDebug(`Deleted Meilisearch index: ${database}`)
  }

  /**
   * Get the storage size of the Meilisearch instance
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port } = container

    try {
      const response = await meilisearchApiRequest(port, 'GET', '/stats')
      if (response.status === 200) {
        const stats = response.data as { databaseSize?: number }
        return stats.databaseSize ?? null
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Dump from a remote Meilisearch connection
   * Uses Meilisearch's REST API to create and download a dump
   *
   * Connection string format: http://host:port or meilisearch://host:port
   * For API key auth: http://host:port?api_key=YOUR_KEY
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // Parse connection string
    const { baseUrl, headers } = parseMeilisearchConnectionString(connectionString)

    logDebug(`Connecting to remote Meilisearch at ${baseUrl}`)

    // Check connectivity and get index count
    const indexesResponse = await remoteMeilisearchRequest(
      baseUrl,
      'GET',
      '/indexes',
      headers,
    )
    if (indexesResponse.status !== 200) {
      throw new Error(
        `Failed to connect to Meilisearch at ${baseUrl}: ${JSON.stringify(indexesResponse.data)}`,
      )
    }

    const indexesData = indexesResponse.data as {
      results?: Array<{ uid: string }>
    }
    const indexCount = indexesData.results?.length ?? 0

    logDebug(`Found ${indexCount} indexes on remote server`)

    // Create a dump on the remote server
    logDebug('Creating dump on remote server...')
    const dumpResponse = await remoteMeilisearchRequest(
      baseUrl,
      'POST',
      '/dumps',
      headers,
    )

    // Meilisearch returns 202 Accepted
    if (dumpResponse.status !== 202 && dumpResponse.status !== 200) {
      throw new Error(
        `Failed to create dump on remote Meilisearch: ${JSON.stringify(dumpResponse.data)}`,
      )
    }

    const dumpData = dumpResponse.data as { taskUid?: number }
    const taskUid = dumpData?.taskUid

    if (taskUid === undefined) {
      throw new Error('Meilisearch dump creation failed: no task UID returned')
    }

    logDebug(`Remote dump task created: ${taskUid}`)

    // Wait for task to complete
    const maxWait = 5 * 60 * 1000 // 5 minutes
    const startTime = Date.now()

    while (Date.now() - startTime < maxWait) {
      const taskResponse = await remoteMeilisearchRequest(
        baseUrl,
        'GET',
        `/tasks/${taskUid}`,
        headers,
      )

      if (taskResponse.status === 200) {
        const task = taskResponse.data as {
          status?: string
          details?: { dumpUid?: string }
        }

        if (task.status === 'succeeded') {
          logDebug(`Dump task succeeded: ${task.details?.dumpUid}`)
          // Note: Meilisearch stores dumps locally on the server
          // We cannot download them via REST API like Qdrant snapshots
          // The user needs to access the server's filesystem

          return {
            filePath: outputPath,
            warnings: [
              `Dump created on remote server. Meilisearch does not support downloading dumps via REST API.`,
              `The dump is stored on the server in the dumps directory.`,
              indexCount === 0
                ? 'Remote Meilisearch instance has no indexes'
                : undefined,
            ].filter((w): w is string => w !== undefined),
          }
        }

        if (task.status === 'failed') {
          throw new Error(
            `Meilisearch dump task failed: ${JSON.stringify(task)}`,
          )
        }
      }

      await new Promise((r) => setTimeout(r, 1000))
    }

    throw new Error('Meilisearch dump task did not complete within timeout')
  }

  // Create a backup
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  // Run a command - Meilisearch uses REST API, not command files
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container

    if (options.file) {
      throw new Error(
        'Meilisearch does not support command files. Use the REST API directly.\n' +
          `Example: curl -X POST http://127.0.0.1:${port}/indexes`,
      )
    }

    if (options.sql) {
      // Try to interpret as a simple command (e.g., "LIST INDEXES")
      const command = options.sql.trim().toUpperCase()

      if (command === 'LIST INDEXES' || command === 'SHOW INDEXES') {
        const response = await meilisearchApiRequest(port, 'GET', '/indexes')
        console.log(JSON.stringify(response.data, null, 2))
        return
      }

      throw new Error(
        'Meilisearch uses REST API for operations. Use curl or the Meilisearch client libraries.\n' +
          `API endpoint: http://127.0.0.1:${port}`,
      )
    }

    throw new Error('Either file or sql option must be provided')
  }
}

export const meilisearchEngine = new MeilisearchEngine()
