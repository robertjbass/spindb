import { generateKeyPairSync, sign } from 'crypto'
import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, openSync, closeSync } from 'fs'
import { mkdir, writeFile, readFile, unlink, stat } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  logDebug,
  UnsupportedOperationError,
  assertValidUsername,
} from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import {
  loadCredentials,
  saveCredentials,
  getDefaultUsername,
  credentialsExist,
} from '../../core/credential-manager'
import { libsqlBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { fetchAvailableVersions as fetchHostdbVersions } from './hostdb-releases'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
import { libsqlQuery, hranaValueToJs, libsqlApiRequest } from './api-client'
import {
  Engine,
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

const ENGINE = 'libsql'
const engineDef = getEngineDefaults(ENGINE)

const START_CHECK_DELAY_MS = isWindows() ? 2000 : 500
const JWT_KEY_FILE = 'jwt-key.pem'

/**
 * Load the auth token for a container from credential-manager, if available.
 * Returns undefined when no credentials are stored.
 */
async function loadAuthToken(
  containerName: string,
): Promise<string | undefined> {
  const username = getDefaultUsername(Engine.LibSQL)
  const creds = await loadCredentials(containerName, Engine.LibSQL, username)
  return creds?.apiKey ?? undefined
}

/** Default JWT TTL: 10 years (effectively non-expiring for local dev) */
const DEFAULT_JWT_TTL_SECONDS = 10 * 365 * 24 * 60 * 60

/**
 * Create a JWT token signed with an Ed25519 private key.
 * Header: {"alg":"EdDSA","typ":"JWT"}
 * Payload: {"a":"rw","exp":...} (read-write access with expiration)
 */
function createJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  ttlSeconds = DEFAULT_JWT_TTL_SECONDS,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }),
  ).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = Buffer.from(JSON.stringify({ a: 'rw', exp })).toString(
    'base64url',
  )
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString(
    'base64url',
  )
  return `${signingInput}.${signature}`
}

export class LibSQLEngine extends BaseEngine {
  name = ENGINE
  displayName = 'libSQL'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  getPlatformInfo(): { platform: Platform; arch: Arch } {
    return platformService.getPlatformInfo()
  }

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchHostdbVersions()
  }

  async fetchDeprecatedVersions(): Promise<Set<string>> {
    return new Set()
  }

  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  resolveFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'libsql',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  async verifyBinary(binPath: string): Promise<boolean> {
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `sqld${ext}`)
    return existsSync(serverPath)
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = this.getPlatformInfo()
    return libsqlBinaryManager.isInstalled(version, platform, arch)
  }

  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()

    const binPath = await libsqlBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    const ext = platformService.getExecutableExtension()
    const sqldPath = join(binPath, 'bin', `sqld${ext}`)
    if (existsSync(sqldPath)) {
      await configManager.setBinaryPath('sqld', sqldPath, 'bundled')
    }

    return binPath
  }

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

    if (!existsSync(containerDir)) {
      await mkdir(containerDir, { recursive: true })
    }

    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      logDebug(`Created libSQL data directory: ${dataDir}`)
    }

    return dataDir
  }

  async getSqldServerPath(version: string): Promise<string> {
    const { platform, arch } = this.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'libsql',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platformService.getExecutableExtension()
    const serverPath = join(binPath, 'bin', `sqld${ext}`)
    if (existsSync(serverPath)) {
      return serverPath
    }
    throw new Error(
      `libSQL ${version} is not installed. Run: spindb engines download libsql ${version}`,
    )
  }

  async getSqldPath(version?: string): Promise<string> {
    const cached = await configManager.getBinaryPath('sqld')
    if (cached && existsSync(cached)) {
      return cached
    }

    if (version) {
      const { platform, arch } = this.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'libsql',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const sqldPath = join(binPath, 'bin', `sqld${ext}`)
      if (existsSync(sqldPath)) {
        return sqldPath
      }
    }

    throw new Error(
      'sqld not found. Run: spindb engines download libsql <version>',
    )
  }

  /**
   * Start libSQL server (sqld)
   * CLI: sqld --http-listen-addr 127.0.0.1:PORT --db-path /path/to/data.db
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version, binaryPath } = container

    const alreadyRunning = await processManager.isRunning(name, {
      engine: ENGINE,
    })
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    let sqldServer: string | null = null

    if (binaryPath && existsSync(binaryPath)) {
      const ext = platformService.getExecutableExtension()
      const serverPath = join(binaryPath, 'bin', `sqld${ext}`)
      if (existsSync(serverPath)) {
        sqldServer = serverPath
        logDebug(`Using stored binary path: ${sqldServer}`)
      }
    }

    if (!sqldServer) {
      try {
        sqldServer = await this.getSqldServerPath(version)
      } catch (error) {
        const originalMessage =
          error instanceof Error ? error.message : String(error)
        throw new Error(
          `libSQL ${version} is not installed. Run: spindb engines download libsql ${version}\n` +
            `  Original error: ${originalMessage}`,
        )
      }
    }

    logDebug(`Using sqld for version ${version}: ${sqldServer}`)

    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'libsql.pid')
    const dbPath = join(dataDir, 'data.db')

    // Check if HTTP port is available
    if (!(await portManager.isPortAvailable(port))) {
      throw new Error(`HTTP port ${port} is already in use.`)
    }

    onProgress?.({ stage: 'starting', message: 'Starting libSQL...' })

    const bindAddr = container.bindAddress ?? '127.0.0.1'
    const args = [
      '--http-listen-addr',
      `${bindAddr}:${port}`,
      '--db-path',
      dbPath,
    ]

    // If a JWT key file exists, enable JWT authentication
    const jwtKeyPath = join(containerDir, JWT_KEY_FILE)
    if (existsSync(jwtKeyPath)) {
      args.push('--auth-jwt-key-file', jwtKeyPath)
      logDebug(`JWT auth enabled via key file: ${jwtKeyPath}`)
    }

    logDebug(`Starting sqld with args: ${args.join(' ')}`)

    const checkLogForError = async (): Promise<string | null> => {
      try {
        const logContent = await readFile(logFile, 'utf-8')
        const recentLog = logContent.slice(-2000)

        if (
          recentLog.includes('Address already in use') ||
          recentLog.includes('bind: Address already in use')
        ) {
          return `Port ${port} is already in use`
        }
      } catch {
        // Log file might not exist yet
      }
      return null
    }

    // Spawn detached process with stderr redirected to logFile for debugging
    const logFd = openSync(logFile, 'a')
    const spawnOpts: SpawnOptions = {
      cwd: containerDir,
      stdio: ['ignore', 'ignore', logFd],
      detached: true,
    }

    const proc = spawn(sqldServer, args, spawnOpts)

    // Write PID file
    if (proc.pid) {
      await writeFile(pidFile, proc.pid.toString())
      logDebug(`libSQL server PID: ${proc.pid}`)
    }

    proc.unref()
    closeSync(logFd)

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, START_CHECK_DELAY_MS))

    // Health check loop
    const maxRetries = 30
    const retryDelay = 500
    let ready = false

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await libsqlApiRequest(port, 'GET', '/health', 2000)
        if (response.status === 200) {
          ready = true
          break
        }
      } catch {
        // Not ready yet
      }

      // Check for startup errors in log
      const logError = await checkLogForError()
      if (logError) {
        throw new Error(`libSQL failed to start: ${logError}`)
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay))
    }

    if (!ready) {
      throw new Error(
        `libSQL failed to start after ${(maxRetries * retryDelay) / 1000}s. Check logs: ${logFile}`,
      )
    }

    onProgress?.({ stage: 'ready', message: 'libSQL is ready' })

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  /**
   * Stop libSQL server
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const containerDir = paths.getContainerPath(name, { engine: ENGINE })
    const pidFile = join(containerDir, 'libsql.pid')

    logDebug(`Stopping libSQL container "${name}" on port ${port}`)

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
      logDebug(`Killing libSQL process ${pid}`)
      try {
        await platformService.terminateProcess(pid, false)
        await new Promise((resolve) => setTimeout(resolve, 2000))

        if (platformService.isProcessRunning(pid)) {
          logDebug(`Graceful termination failed, force killing ${pid}`)
          await platformService.terminateProcess(pid, true)
        }
      } catch (error) {
        logDebug(`Process termination error: ${error}`)
      }
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

    // Cleanup PID file
    if (existsSync(pidFile)) {
      try {
        await unlink(pidFile)
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Check if libSQL is running
   */
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const running = await processManager.isRunning(name, { engine: ENGINE })

    if (running) {
      // Verify server is responsive
      try {
        const response = await libsqlApiRequest(port, 'GET', '/health', 2000)
        if (response.status === 200) {
          return { running: true, message: `libSQL is running on port ${port}` }
        }
      } catch {
        // Process exists but not responding
      }
      return {
        running: true,
        message: `libSQL process is running but not responding on port ${port}`,
      }
    }

    return { running: false, message: 'libSQL is not running' }
  }

  /**
   * Connect to libSQL - opens the HTTP URL
   * libSQL is a REST API engine with no native CLI shell
   */
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const { name, port } = container
    const url = `http://127.0.0.1:${port}`

    console.log(`libSQL HTTP API: ${url}`)
    console.log(`Query endpoint: ${url}/v2/pipeline`)
    console.log(`Health check: ${url}/health`)

    const authToken = await loadAuthToken(name)
    if (authToken) {
      console.log('')
      console.log('Authentication is enabled. Include the auth token header:')
      console.log(`  Authorization: Bearer ${authToken}`)
    }

    console.log('')
    console.log('Use any HTTP client or libSQL SDK to connect.')
    console.log('Example with curl:')
    const authHeader = authToken
      ? ` -H "Authorization: Bearer ${authToken}"`
      : ''
    console.log(
      `  curl -s ${url}/v2/pipeline -H "Content-Type: application/json"${authHeader} -d '{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}'`,
    )
  }

  getConnectionString(container: ContainerConfig, _database?: string): string {
    return `http://127.0.0.1:${container.port}`
  }

  /**
   * Execute a SQL query via the Hrana HTTP protocol
   */
  async executeQuery(
    container: ContainerConfig,
    query: string,
    _options?: QueryOptions,
  ): Promise<QueryResult> {
    const port = container.port

    // Load auth token from credentials if available
    const authToken = await loadAuthToken(container.name)

    const result = await libsqlQuery(port, query, {
      authToken,
    })

    const columns = result.cols.map((col) => col.name)
    const rows = result.rows.map((row) => {
      const obj: Record<string, unknown> = {}
      result.cols.forEach((col, i) => {
        obj[col.name] = hranaValueToJs(row[i])
      })
      return obj
    })

    return {
      columns,
      rows,
      rowCount: rows.length,
    }
  }

  /**
   * List databases - libSQL runs a single database per instance
   */
  async listDatabases(_container: ContainerConfig): Promise<string[]> {
    return ['main']
  }

  /**
   * Create database - not supported (single database per instance)
   */
  async createDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    throw new UnsupportedOperationError(
      'createDatabase',
      'libSQL',
      'libSQL runs a single SQLite database per server instance. Use "spindb create" to make a new instance.',
    )
  }

  /**
   * Drop database - not supported (single database per instance)
   */
  async dropDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    throw new UnsupportedOperationError(
      'dropDatabase',
      'libSQL',
      'libSQL runs a single SQLite database per server instance. Use "spindb delete" to remove the instance.',
    )
  }

  /**
   * Create a backup
   */
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  /**
   * Restore from a backup
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options?: { format?: string },
  ): Promise<RestoreResult> {
    const containerDir = paths.getContainerPath(container.name, {
      engine: ENGINE,
    })
    const dataDir = join(containerDir, 'data')

    return restoreBackup(backupPath, {
      containerName: container.name,
      dataDir,
      port: container.port,
      format: options?.format as 'sql' | 'binary' | undefined,
    })
  }

  /**
   * Detect backup format from file
   */
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Dump from a remote connection string
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // Parse the connection string to get host:port
    let url: URL
    let normalized = connectionString.trim()
    if (
      !normalized.startsWith('http://') &&
      !normalized.startsWith('https://')
    ) {
      normalized = `http://${normalized}`
    }
    try {
      url = new URL(normalized)
    } catch {
      throw new Error(
        `Invalid libSQL connection string: ${connectionString}\n` +
          'Expected format: http://host:port',
      )
    }

    const port = parseInt(url.port || '8080', 10)

    // Create a temporary container config for the backup
    const tmpContainer: ContainerConfig = {
      name: '__remote_dump__',
      engine: 'libsql' as ContainerConfig['engine'],
      version: '0',
      port,
      database: 'main',
      created: new Date().toISOString(),
      status: 'running',
    }

    const result = await createBackup(tmpContainer, outputPath, {
      database: 'main',
      format: 'sql',
    })

    return {
      filePath: result.path,
    }
  }

  /**
   * Get database size
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const containerDir = paths.getContainerPath(container.name, {
      engine: ENGINE,
    })
    // sqld's data.db is a directory; the actual SQLite file is inside
    const sqliteFile = join(
      containerDir,
      'data',
      'data.db',
      'dbs',
      'default',
      'data',
    )

    if (!existsSync(sqliteFile)) {
      return null
    }

    try {
      const { size } = await stat(sqliteFile)
      return size
    } catch {
      return null
    }
  }

  /**
   * Run a script file - not supported for REST API engines
   */
  async runScript(
    _container: ContainerConfig,
    _options: { scriptPath: string; database?: string },
  ): Promise<void> {
    throw new UnsupportedOperationError(
      'runScript',
      'libSQL',
      'libSQL is a REST API engine. Use the HTTP API or a libSQL SDK to run scripts.',
    )
  }

  /**
   * Create a JWT auth token for libSQL.
   *
   * Generates an Ed25519 key pair, writes the public key to the container
   * directory so sqld can verify tokens, creates a JWT with read-write
   * access, and stores it via credential-manager.
   *
   * Idempotent: if the key file and credentials already exist, returns
   * the existing credentials without regenerating.
   */
  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username } = options
    assertValidUsername(username)

    const containerDir = paths.getContainerPath(container.name, {
      engine: ENGINE,
    })
    const jwtKeyPath = join(containerDir, JWT_KEY_FILE)

    // Idempotent: if key file exists and credentials are stored, return existing
    if (
      existsSync(jwtKeyPath) &&
      credentialsExist(container.name, Engine.LibSQL, username)
    ) {
      const existing = await loadCredentials(
        container.name,
        Engine.LibSQL,
        username,
      )
      if (existing) {
        logDebug(`Found existing libSQL JWT credentials for ${username}`)
        return existing
      }
    }

    // Generate Ed25519 key pair
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')

    // Write the public key in PEM format for sqld
    const publicKeyPem = publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string
    await writeFile(jwtKeyPath, publicKeyPem, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    logDebug(`Wrote JWT public key to ${jwtKeyPath}`)

    // Create a JWT token with read-write access
    const token = createJwt(privateKey)

    // Restart sqld so it picks up the new key file
    const isRunning = await processManager.isRunning(container.name, {
      engine: ENGINE,
    })
    if (isRunning) {
      logDebug('Restarting sqld to pick up JWT key file')
      await this.stop(container)
      await this.start(container)
    }

    // Store credentials via credential-manager
    const connectionString = this.getConnectionString(container)
    const credentials: UserCredentials = {
      username,
      password: '',
      connectionString,
      engine: container.engine,
      container: container.name,
      apiKey: token,
    }

    await saveCredentials(container.name, Engine.LibSQL, credentials)
    logDebug(`Saved libSQL JWT credentials for ${username}`)

    return credentials
  }
}

export const libsqlEngine = new LibSQLEngine()
