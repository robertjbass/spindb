/**
 * MariaDB Engine implementation
 * Manages MariaDB database containers using pre-built binaries from hostdb
 */

import { spawn, exec, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync, createReadStream } from 'fs'
import { mkdir, writeFile, readFile, unlink, rm } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import {
  platformService,
  isWindows,
  getWindowsSpawnOptions,
} from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import {
  logDebug,
  logWarning,
  ErrorCodes,
  SpinDBError,
  assertValidDatabaseName,
} from '../../core/error-handler'
import { mariadbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import { fetchAvailableVersions, getLatestVersion } from './hostdb-releases'
import { SUPPORTED_MAJOR_VERSIONS, MARIADB_VERSION_MAP } from './version-maps'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
  parseConnectionString,
} from './restore'
import { createBackup } from './backup'
import {
  Platform,
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

const execAsync = promisify(exec)

const ENGINE = 'mariadb'
const engineDef = getEngineDefaults(ENGINE)

// Build a Windows-safe mariadb command string for either a file or inline SQL.
export function buildWindowsMariadbCommand(
  mysqlPath: string,
  port: number,
  user: string,
  db: string,
  options: { file?: string; sql?: string },
): string {
  if (!options.file && !options.sql) {
    throw new Error('Either file or sql option must be provided')
  }

  let cmd = `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u ${user} ${db}`

  if (options.file) {
    cmd += ` < "${options.file}"`
  } else if (options.sql) {
    const escaped = options.sql.replace(/"/g, '\\"')
    cmd += ` -e "${escaped}"`
  }

  return cmd
}

// Build a platform-safe mariadb command string with SQL inline.
export function buildMariadbInlineCommand(
  mysqlPath: string,
  port: number,
  user: string,
  sql: string,
  options: { database?: string } = {},
): string {
  const dbArg = options.database ? ` ${options.database}` : ''

  if (isWindows()) {
    const escaped = sql.replace(/"/g, '\\"')
    return `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u ${user}${dbArg} -e "${escaped}"`
  } else {
    const escaped = sql.replace(/'/g, "'\\''")
    return `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u ${user}${dbArg} -e '${escaped}'`
  }
}

export class MariaDBEngine extends BaseEngine {
  name = ENGINE
  displayName = 'MariaDB'
  defaultPort = engineDef.defaultPort
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchAvailableVersions()
  }

  getPlatformInfo(): { platform: Platform; arch: Arch } {
    const info = platformService.getPlatformInfo()
    return {
      platform: info.platform,
      arch: info.arch,
    }
  }

  resolveFullVersion(version: string): string {
    // Check if already a full version (has at least two dots)
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return version
    }
    // It's a major version, resolve using fallback map
    return MARIADB_VERSION_MAP[version] || `${version}.0`
  }

  async resolveFullVersionAsync(version: string): Promise<string> {
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return version
    }
    return getLatestVersion(version)
  }

  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'mariadb',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  getBinaryUrl(version: string, plat: Platform, arc: Arch): string {
    return getBinaryUrl(version, plat, arc)
  }

  async verifyBinary(binPath: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    const parts = binPath.split('-')
    const version = parts[1]
    return mariadbBinaryManager.verify(version, p, a)
  }

  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    const binPath = await mariadbBinaryManager.ensureInstalled(
      version,
      p,
      a,
      onProgress,
    )

    // Register all MariaDB binaries from downloaded package
    // Using native names only (not mysql-named ones to avoid conflicts with MySQL engine)
    const ext = platformService.getExecutableExtension()
    const tools = [
      'mariadbd',
      'mariadb-admin',
      'mariadb',
      'mariadb-dump',
    ] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      } else {
        logDebug(`Expected MariaDB binary not found`, { tool, toolPath })
      }
    }

    return binPath
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return mariadbBinaryManager.isInstalled(version, p, a)
  }

  async initDataDir(
    containerName: string,
    version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const binPath = this.getBinaryPath(version)
    const ext = platformService.getExecutableExtension()
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    let createdDataDir = false

    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
      createdDataDir = true
    }

    const cleanupOnFailure = async () => {
      if (createdDataDir) {
        try {
          await rm(dataDir, { recursive: true, force: true })
          logDebug(`Cleaned up data directory after init failure: ${dataDir}`)
        } catch (cleanupErr) {
          logDebug(
            `Failed to clean up data directory: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          )
        }
      }
    }

    // Try mariadb-install-db first, then mysql_install_db
    let installDb = join(binPath, 'scripts', `mariadb-install-db${ext}`)
    if (!existsSync(installDb)) {
      installDb = join(binPath, 'scripts', `mysql_install_db${ext}`)
    }
    if (!existsSync(installDb)) {
      installDb = join(binPath, 'bin', `mariadb-install-db${ext}`)
    }
    if (!existsSync(installDb)) {
      installDb = join(binPath, 'bin', `mysql_install_db${ext}`)
    }

    if (!existsSync(installDb)) {
      await cleanupOnFailure()
      throw new Error(
        `MariaDB initialization script not found in ${binPath}.\n` +
          'Re-download the MariaDB binaries: spindb engines download mariadb',
      )
    }

    // MariaDB initialization
    // Windows mariadb-install-db.exe has limited options support
    // Unix supports --auth-root-authentication-method=normal for passwordless root login
    if (isWindows()) {
      // Windows mariadb-install-db.exe only supports --datadir
      // It does NOT support --auth-root-authentication-method or --basedir options
      const cmd = `"${installDb}" --datadir="${dataDir}"`

      return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 120000 }, async (error, stdout, stderr) => {
          if (error) {
            await cleanupOnFailure()
            reject(
              new Error(
                `MariaDB initialization failed with code ${error.code}: ${stderr || stdout || error.message}`,
              ),
            )
          } else {
            resolve(dataDir)
          }
        })
      })
    }

    // Unix path (Linux/macOS)
    // --no-defaults: Prevent reading system my.cnf files that might have MySQL-specific options
    // --auth-root-authentication-method=normal: Allow passwordless root login for local dev
    // --user: Required for non-root, but when running as root we can skip it to avoid
    //         needing a dedicated 'mysql' user to exist on the system
    const isRunningAsRoot = process.getuid?.() === 0
    const args = [
      '--no-defaults',
      `--datadir=${dataDir}`,
      '--auth-root-authentication-method=normal',
      `--basedir=${binPath}`,
    ]

    // Only add --user when not running as root
    // When running as root, mariadb-install-db works without specifying a user
    if (!isRunningAsRoot && process.env.USER) {
      args.push(`--user=${process.env.USER}`)
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(installDb, args, {
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
          resolve(dataDir)
        } else {
          await cleanupOnFailure()
          reject(
            new Error(
              `MariaDB initialization failed with code ${code}: ${stderr || stdout}`,
            ),
          )
        }
      })

      proc.on('error', async (err) => {
        await cleanupOnFailure()
        reject(err)
      })
    })
  }

  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port, version } = container

    const alreadyRunning = await this.isRunning(name)
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    const binPath = this.getBinaryPath(version)
    const ext = platformService.getExecutableExtension()

    // Try mariadbd first, then mysqld
    let mysqld = join(binPath, 'bin', `mariadbd${ext}`)
    if (!existsSync(mysqld)) {
      mysqld = join(binPath, 'bin', `mysqld${ext}`)
    }

    if (!existsSync(mysqld)) {
      throw new Error(
        `MariaDB server binary not found in ${binPath}/bin/.\n` +
          'Re-download the MariaDB binaries: spindb engines download mariadb',
      )
    }

    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })
    const { platform } = platformService.getPlatformInfo()

    onProgress?.({ stage: 'starting', message: 'Starting MariaDB...' })

    // --no-defaults: CRITICAL - prevents reading system my.cnf files that might contain
    // MySQL-specific options like mysqlx-bind-address which MariaDB doesn't support
    const args = [
      '--no-defaults',
      `--datadir=${dataDir}`,
      `--port=${port}`,
      `--pid-file=${pidFile}`,
      `--log-error=${logFile}`,
      '--bind-address=127.0.0.1',
      `--max-connections=${engineDef.maxConnections}`,
    ]

    if (platform !== Platform.Win32) {
      const socketFile = join(
        paths.getContainerPath(name, { engine: ENGINE }),
        'mysql.sock',
      )
      args.push(`--socket=${socketFile}`)
    }

    let proc: ReturnType<typeof spawn> | null = null

    if (isWindows()) {
      proc = spawn(mysqld, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      })

      proc.stdout?.on('data', (data: Buffer) => {
        logDebug(`mariadbd stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        logDebug(`mariadbd stderr: ${data.toString()}`)
      })

      proc.unref()
    } else {
      proc = spawn(mysqld, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      })
      proc.unref()
    }

    return new Promise((resolve, reject) => {
      // Track whether we've already settled the promise to avoid race conditions
      let settled = false

      const errorHandler = (err: Error) => {
        if (settled) return
        settled = true
        if (proc) {
          proc.removeListener('error', errorHandler)
        }
        reject(err)
      }

      if (proc) {
        proc.on('error', errorHandler)
      }

      setTimeout(async () => {
        if (proc && proc.pid) {
          try {
            await writeFile(pidFile, String(proc.pid))
          } catch (error) {
            logDebug(`Could not write PID file: ${error}`)
          }
        }

        // Wait for MariaDB to be ready
        let attempts = 0
        const maxAttempts = 30
        const checkInterval = 500

        const checkReady = async () => {
          if (settled) return
          attempts++
          try {
            const mysqladmin = await this.getMysqladminPath()
            await execAsync(
              `"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`,
            )
            if (settled) return
            settled = true
            if (proc) {
              proc.removeListener('error', errorHandler)
            }
            resolve({
              port,
              connectionString: this.getConnectionString(container),
            })
          } catch {
            if (settled) return
            if (attempts < maxAttempts) {
              setTimeout(checkReady, checkInterval)
            } else {
              if (settled) return
              settled = true
              if (proc) {
                proc.removeListener('error', errorHandler)
              }
              reject(new Error('MariaDB failed to start within timeout'))
            }
          }
        }

        checkReady()
      }, 1000)
    })
  }

  private async isRunning(containerName: string): Promise<boolean> {
    const pidFile = paths.getContainerPidPath(containerName, { engine: ENGINE })
    if (!existsSync(pidFile)) {
      return false
    }

    try {
      const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
      return platformService.isProcessRunning(pid)
    } catch {
      return false
    }
  }

  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })

    logDebug(`Stopping MariaDB container "${name}" on port ${port}`)

    const pid = await this.getValidatedPid(pidFile)
    if (pid === null) {
      logDebug('No valid PID, checking if MariaDB is responding on port')
      try {
        const mysqladmin = await this.getMysqladminPath()
        await execAsync(
          `"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`,
          { timeout: 2000 },
        )
        logWarning(`MariaDB responding on port ${port} but no valid PID file`)
        await this.gracefulShutdown(port)
      } catch {
        logDebug('MariaDB not responding, nothing to stop')
      }
      return
    }

    const gracefulSuccess = await this.gracefulShutdown(port, pid)
    if (gracefulSuccess) {
      await this.cleanupPidFile(pidFile)
      logDebug('MariaDB stopped gracefully')
      return
    }

    await this.forceKillWithEscalation(pid, pidFile)
  }

  private async getValidatedPid(pidFile: string): Promise<number | null> {
    if (!existsSync(pidFile)) {
      logDebug('PID file does not exist')
      return null
    }

    try {
      const content = await readFile(pidFile, 'utf8')
      const pid = parseInt(content.trim(), 10)

      if (isNaN(pid) || pid <= 0) {
        logWarning(`PID file contains invalid value: "${content.trim()}"`)
        await this.cleanupPidFile(pidFile)
        return null
      }

      if (platformService.isProcessRunning(pid)) {
        logDebug(`Validated PID ${pid}`)
        return pid
      } else {
        logWarning(`PID file references non-existent process ${pid}`)
        await this.cleanupPidFile(pidFile)
        return null
      }
    } catch (error) {
      const e = error as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        logWarning(`Failed to read PID file: ${e.message}`)
      }
      return null
    }
  }

  private async gracefulShutdown(
    port: number,
    pid?: number,
    timeoutMs = 10000,
  ): Promise<boolean> {
    try {
      const mysqladmin = await this.getMysqladminPath()
      logDebug('Attempting mysqladmin shutdown')
      await execAsync(
        `"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root shutdown`,
        { timeout: 5000 },
      )
    } catch (error) {
      const e = error as Error
      logDebug(`mysqladmin shutdown failed: ${e.message}`)
      if (pid) {
        try {
          await platformService.terminateProcess(pid, false)
        } catch {
          return true
        }
      }
    }

    if (pid) {
      const startTime = Date.now()
      const checkIntervalMs = 200

      while (Date.now() - startTime < timeoutMs) {
        if (!platformService.isProcessRunning(pid)) {
          logDebug(`Process ${pid} terminated after graceful shutdown`)
          return true
        }
        await this.sleep(checkIntervalMs)
      }

      logDebug(`Graceful shutdown timed out after ${timeoutMs}ms`)
      return false
    }

    return true
  }

  private async forceKillWithEscalation(
    pid: number,
    pidFile: string,
  ): Promise<void> {
    logWarning(`Graceful shutdown failed, force killing process ${pid}`)

    try {
      await platformService.terminateProcess(pid, false)
      await this.sleep(2000)

      if (!platformService.isProcessRunning(pid)) {
        logDebug(`Process ${pid} terminated after graceful signal`)
        await this.cleanupPidFile(pidFile)
        return
      }
    } catch (error) {
      const e = error as NodeJS.ErrnoException
      if (e.code === 'ESRCH') {
        await this.cleanupPidFile(pidFile)
        return
      }
      logDebug(`Graceful termination failed: ${e.message}`)
    }

    const { platform } = platformService.getPlatformInfo()
    const killCmd = platform === Platform.Win32 ? 'taskkill /F' : 'kill -9'
    logWarning(`Escalating to force kill for process ${pid}`)
    try {
      await platformService.terminateProcess(pid, true)
      await this.sleep(1000)

      if (platformService.isProcessRunning(pid)) {
        throw new SpinDBError(
          ErrorCodes.PROCESS_STOP_TIMEOUT,
          `Failed to stop MariaDB process ${pid} even with force kill`,
          'error',
          `Try manually killing the process: ${killCmd} ${pid}`,
        )
      }
      logDebug(`Process ${pid} terminated after force kill`)
      await this.cleanupPidFile(pidFile)
    } catch (error) {
      if (error instanceof SpinDBError) throw error
      const e = error as NodeJS.ErrnoException
      if (e.code === 'ESRCH') {
        await this.cleanupPidFile(pidFile)
        return
      }
      logDebug(`Force kill failed: ${e.message}`)
    }
  }

  private async cleanupPidFile(pidFile: string): Promise<void> {
    try {
      await unlink(pidFile)
      logDebug('PID file cleaned up')
    } catch (error) {
      const e = error as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        logDebug(`Failed to clean up PID file: ${e.message}`)
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })

    if (!existsSync(pidFile)) {
      return { running: false, message: 'MariaDB is not running' }
    }

    try {
      const mysqladmin = await this.getMysqladminPath()
      await execAsync(`"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`)
      return { running: true, message: 'MariaDB is running' }
    } catch {
      return { running: false, message: 'MariaDB is not responding' }
    }
  }

  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: Record<string, unknown> = {},
  ): Promise<RestoreResult> {
    const { port, version } = container
    const database = (options.database as string) || container.database
    const binPath = this.getBinaryPath(version)

    if (options.createDatabase !== false) {
      await this.createDatabase(container, database)
    }

    return restoreBackup(backupPath, {
      port,
      database,
      user: engineDef.superuser,
      createDatabase: false,
      validateVersion: options.validateVersion !== false,
      binPath,
    })
  }

  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'mysql'
    return `mysql://${engineDef.superuser}@127.0.0.1:${port}/${db}`
  }

  override async getMariadbClientPath(): Promise<string> {
    const configPath = await configManager.getBinaryPath('mariadb')
    if (configPath) return configPath

    throw new Error(
      'mariadb client not found. Ensure MariaDB binaries are downloaded:\n' +
        '  spindb engines download mariadb',
    )
  }

  override async getMysqladminPath(): Promise<string> {
    const cfg = await configManager.getBinaryPath('mariadb-admin')
    if (cfg) return cfg

    throw new Error(
      'mariadb-admin not found. Ensure MariaDB binaries are downloaded:\n' +
        '  spindb engines download mariadb',
    )
  }

  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || container.database || 'mysql'

    const mysql = await this.getMariadbClientPath()

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      ...getWindowsSpawnOptions(),
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        mysql,
        ['-h', '127.0.0.1', '-P', String(port), '-u', engineDef.superuser, db],
        spawnOptions,
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container

    const mysql = await this.getMariadbClientPath()

    try {
      const cmd = buildMariadbInlineCommand(
        mysql,
        port,
        engineDef.superuser,
        `CREATE DATABASE IF NOT EXISTS \`${database}\``,
      )
      await execAsync(cmd)
    } catch (error) {
      const err = error as Error
      if (!err.message.includes('database exists')) {
        throw error
      }
    }
  }

  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container

    const mysql = await this.getMariadbClientPath()

    try {
      const cmd = buildMariadbInlineCommand(
        mysql,
        port,
        engineDef.superuser,
        `DROP DATABASE IF EXISTS \`${database}\``,
      )
      await execAsync(cmd)
    } catch (error) {
      const err = error as Error
      if (!err.message.includes("database doesn't exist")) {
        throw error
      }
    }
  }

  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, database } = container
    const db = database || 'mysql'

    assertValidDatabaseName(db)

    try {
      const mysql = await this.getMariadbClientPath()

      const { stdout } = await execAsync(
        `"${mysql}" -h 127.0.0.1 -P ${port} -u ${engineDef.superuser} -N -e "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = '${db}'"`,
      )
      const size = parseInt(stdout.trim(), 10)
      return isNaN(size) ? null : size
    } catch {
      return null
    }
  }

  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const dumpPath = await this.getDumpPath()

    const { host, port, user, password, database } =
      parseConnectionString(connectionString)

    if (isWindows()) {
      let cmd = `"${dumpPath}" -h ${host} -P ${port} -u ${user} --result-file "${outputPath}" ${database}`
      let safeCmd = cmd

      if (password) {
        cmd = `"${dumpPath}" -h ${host} -P ${port} -u ${user} -p"${password}" --result-file "${outputPath}" ${database}`
        safeCmd = `"${dumpPath}" -h ${host} -P ${port} -u ${user} -p"****" --result-file "${outputPath}" ${database}`
      }
      try {
        logDebug('Executing mariadb-dump command', { cmd: safeCmd })
        await execAsync(cmd)
        return {
          filePath: outputPath,
          stdout: '',
          stderr: '',
          code: 0,
        }
      } catch (error) {
        throw new Error((error as Error).message)
      }
    }

    const args = [
      '-h',
      host,
      '-P',
      port,
      '-u',
      user,
      '--result-file',
      outputPath,
    ]

    if (password) {
      args.push(`-p${password}`)
    }

    args.push(database)

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...getWindowsSpawnOptions(),
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(dumpPath, args, spawnOptions)

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
          reject(new Error(stderr || `mariadb-dump exited with code ${code}`))
        }
      })
    })
  }

  private async getDumpPath(): Promise<string> {
    const configPath = await configManager.getBinaryPath('mariadb-dump')
    if (configPath) return configPath

    throw new Error(
      'mariadb-dump not found. Ensure MariaDB binaries are downloaded:\n' +
        '  spindb engines download mariadb',
    )
  }

  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  async terminateConnections(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container
    const mysql = await this.getMariadbClientPath()

    // Get all connection IDs for the target database and kill them
    // We need to do this in two steps since MariaDB doesn't support subqueries in KILL
    const getIdsCmd = buildMariadbInlineCommand(
      mysql,
      port,
      engineDef.superuser,
      `SELECT ID FROM information_schema.PROCESSLIST WHERE DB = '${database}' AND ID != CONNECTION_ID()`,
    )

    try {
      const { stdout } = await execAsync(getIdsCmd)
      const lines = stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim())
      // Skip header row if present
      const ids = lines
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))

      for (const id of ids) {
        const killCmd = buildMariadbInlineCommand(
          mysql,
          port,
          engineDef.superuser,
          `KILL CONNECTION ${id}`,
        )
        try {
          await execAsync(killCmd)
        } catch {
          // Connection may already be gone
        }
      }
    } catch {
      // Ignore errors - connections may already be gone
    }
  }

  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container
    const db = options.database || container.database || 'mysql'
    assertValidDatabaseName(db)

    const mysql = await this.getMariadbClientPath()

    if (isWindows()) {
      const cmd = buildWindowsMariadbCommand(
        mysql,
        port,
        engineDef.superuser,
        db,
        options,
      )
      try {
        const { stdout, stderr } = await execAsync(cmd)
        if (stdout) process.stdout.write(stdout)
        if (stderr) process.stderr.write(stderr)
        return
      } catch (error) {
        const err = error as Error
        throw new Error(`mariadb client failed: ${err.message}`)
      }
    }

    const args = [
      '-h',
      '127.0.0.1',
      '-P',
      String(port),
      '-u',
      engineDef.superuser,
      db,
    ]

    if (options.sql) {
      args.push('-e', options.sql)

      const spawnOptions: SpawnOptions = {
        stdio: 'inherit',
      }

      return new Promise((resolve, reject) => {
        const proc = spawn(mysql, args, spawnOptions)

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`mariadb client exited with code ${code}`))
          }
        })
      })
    } else if (options.file) {
      const spawnOptions: SpawnOptions = {
        stdio: ['pipe', 'inherit', 'inherit'],
      }

      return new Promise((resolve, reject) => {
        const fileStream = createReadStream(options.file!)
        const proc = spawn(mysql, args, spawnOptions)

        fileStream.pipe(proc.stdin!)

        fileStream.on('error', (err) => {
          proc.kill()
          reject(err)
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`mariadb client exited with code ${code}`))
          }
        })
      })
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }
}

export const mariadbEngine = new MariaDBEngine()
