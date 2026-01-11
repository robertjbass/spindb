/**
 * MySQL Engine implementation
 * Manages MySQL database containers using pre-built binaries from hostdb
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
import { mysqlBinaryManager } from './binary-manager'
import {
  getBinaryUrl,
  fetchAvailableVersions,
  getLatestVersion,
  FALLBACK_VERSION_MAP,
} from './binary-urls'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
  parseConnectionString,
} from './restore'
import { createBackup } from './backup'
import type {
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  BackupOptions,
  BackupResult,
  RestoreResult,
  DumpResult,
  StatusResult,
} from '../../types'

const execAsync = promisify(exec)

const ENGINE = 'mysql'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Build a Windows-safe mysql command string for either a file or inline SQL.
 * This is exported for unit testing.
 */
export function buildWindowsMysqlCommand(
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
    // Redirection requires shell, so use < operator
    cmd += ` < "${options.file}"`
  } else if (options.sql) {
    const escaped = options.sql.replace(/"/g, '\\"')
    cmd += ` -e "${escaped}"`
  }

  return cmd
}

/**
 * Build a platform-safe mysql command string with SQL inline.
 * On Unix, uses single quotes to prevent shell interpretation of backticks.
 * On Windows, uses double quotes (backticks are literal in cmd.exe).
 * This is exported for unit testing.
 */
export function buildMysqlInlineCommand(
  mysqlPath: string,
  port: number,
  user: string,
  sql: string,
  options: { database?: string } = {},
): string {
  const dbArg = options.database ? ` ${options.database}` : ''

  if (isWindows()) {
    // Windows: use double quotes, escape inner double quotes
    const escaped = sql.replace(/"/g, '\\"')
    return `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u ${user}${dbArg} -e "${escaped}"`
  } else {
    // Unix: use single quotes to prevent backtick interpretation
    // Escape any single quotes in the SQL by ending the string, adding escaped quote, starting new string
    const escaped = sql.replace(/'/g, "'\\''")
    return `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u ${user}${dbArg} -e '${escaped}'`
  }
}

export class MySQLEngine extends BaseEngine {
  name = ENGINE
  displayName = 'MySQL'
  defaultPort = engineDef.defaultPort
  supportedVersions = engineDef.supportedVersions

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchAvailableVersions()
  }

  getPlatformInfo(): { platform: string; arch: string } {
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
    return FALLBACK_VERSION_MAP[version] || `${version}.0.0`
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
      engine: 'mysql',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  getBinaryUrl(version: string, plat: string, arc: string): string {
    return getBinaryUrl(version, plat, arc)
  }

  /**
   * Verify MySQL binaries are installed and working
   * @param binPath - Path to the binary directory
   * @param version - Optional explicit version (preferred over path extraction)
   */
  async verifyBinary(binPath: string, version?: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()

    // Use explicit version if provided
    if (version) {
      return mysqlBinaryManager.verify(version, p, a)
    }

    // Fallback: extract version from path (less reliable)
    // Matches patterns like mysql-8.0.40-darwin-arm64 or mysql-9.0.0-linux-x64
    const basename = binPath.split('/').pop() || binPath.split('\\').pop() || ''
    const versionMatch = basename.match(/\b(\d+\.\d+\.\d+)\b/)
    if (!versionMatch) {
      logDebug(`Could not extract version from binary path: ${binPath}`)
      return false
    }
    logDebug(
      `Extracted version ${versionMatch[1]} from path (prefer explicit version)`,
    )
    return mysqlBinaryManager.verify(versionMatch[1], p, a)
  }

  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    const binPath = await mysqlBinaryManager.ensureInstalled(
      version,
      p,
      a,
      onProgress,
    )

    // Register all MySQL binaries from downloaded package
    const ext = platformService.getExecutableExtension()

    // Server binaries
    const serverTools = ['mysqld', 'mysqladmin'] as const
    for (const tool of serverTools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    // Client tools
    const clientTools = ['mysql', 'mysqldump'] as const
    for (const tool of clientTools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return mysqlBinaryManager.isInstalled(version, p, a)
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

    // MySQL uses mysqld --initialize-insecure
    const mysqld = join(binPath, 'bin', `mysqld${ext}`)

    if (!existsSync(mysqld)) {
      await cleanupOnFailure()
      throw new Error(
        `MySQL server binary not found in ${binPath}/bin/.\n` +
          'Re-download the MySQL binaries: spindb engines download mysql',
      )
    }

    // MySQL initialization
    // --initialize-insecure creates root user without password (for local dev)
    if (isWindows()) {
      // On Windows, use exec with properly quoted command
      const cmd = `"${mysqld}" --initialize-insecure --datadir="${dataDir}"`

      return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 120000 }, async (error, stdout, stderr) => {
          if (error) {
            await cleanupOnFailure()
            reject(
              new Error(
                `MySQL initialization failed with code ${error.code}: ${stderr || stdout || error.message}`,
              ),
            )
          } else {
            resolve(dataDir)
          }
        })
      })
    }

    // Unix path - use spawn without shell
    // --user: Required for non-root, but when running as root we can skip it to avoid
    //         needing a dedicated 'mysql' user to exist on the system
    const isRunningAsRoot = process.getuid?.() === 0
    const args = [
      '--initialize-insecure',
      `--datadir=${dataDir}`,
      `--basedir=${binPath}`,
    ]

    // Only add --user when not running as root
    // When running as root, mysqld --initialize-insecure works without specifying a user
    if (!isRunningAsRoot && process.env.USER) {
      args.push(`--user=${process.env.USER}`)
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(mysqld, args, {
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
              `MySQL initialization failed with code ${code}: ${stderr || stdout}`,
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
    const mysqld = join(binPath, 'bin', `mysqld${ext}`)

    if (!existsSync(mysqld)) {
      throw new Error(
        `MySQL server binary not found in ${binPath}/bin/.\n` +
          'Re-download the MySQL binaries: spindb engines download mysql',
      )
    }

    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })
    const { platform } = platformService.getPlatformInfo()

    onProgress?.({ stage: 'starting', message: 'Starting MySQL...' })

    const args = [
      `--datadir=${dataDir}`,
      `--port=${port}`,
      `--pid-file=${pidFile}`,
      `--log-error=${logFile}`,
      '--bind-address=127.0.0.1',
      `--max-connections=${engineDef.maxConnections}`,
    ]

    if (platform !== 'win32') {
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
        logDebug(`mysqld stdout: ${data.toString()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        logDebug(`mysqld stderr: ${data.toString()}`)
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

        // Wait for MySQL to be ready
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
              reject(new Error('MySQL failed to start within timeout'))
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

    logDebug(`Stopping MySQL container "${name}" on port ${port}`)

    const pid = await this.getValidatedPid(pidFile)
    if (pid === null) {
      logDebug('No valid PID, checking if MySQL is responding on port')
      try {
        const mysqladmin = await this.getMysqladminPath()
        await execAsync(
          `"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`,
          { timeout: 2000 },
        )
        logWarning(`MySQL responding on port ${port} but no valid PID file`)
        await this.gracefulShutdown(port)
      } catch {
        logDebug('MySQL not responding, nothing to stop')
      }
      return
    }

    const gracefulSuccess = await this.gracefulShutdown(port, pid)
    if (gracefulSuccess) {
      await this.cleanupPidFile(pidFile)
      logDebug('MySQL stopped gracefully')
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
        } catch (terminateError) {
          const termErr = terminateError as NodeJS.ErrnoException
          // ESRCH means process doesn't exist - it's already gone
          if (termErr.code === 'ESRCH') {
            logDebug(`Process ${pid} already terminated (ESRCH)`)
            return true
          }
          logDebug(
            `terminateProcess failed for PID ${pid}: ${termErr.message}`,
          )
          return false
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
    const killCmd = platform === 'win32' ? 'taskkill /F' : 'kill -9'
    logWarning(`Escalating to force kill for process ${pid}`)
    try {
      await platformService.terminateProcess(pid, true)
      await this.sleep(1000)

      if (platformService.isProcessRunning(pid)) {
        throw new SpinDBError(
          ErrorCodes.PROCESS_STOP_TIMEOUT,
          `Failed to stop MySQL process ${pid} even with force kill`,
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
      return { running: false, message: 'MySQL is not running' }
    }

    try {
      const mysqladmin = await this.getMysqladminPath()
      await execAsync(`"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`)
      return { running: true, message: 'MySQL is running' }
    } catch {
      return { running: false, message: 'MySQL is not responding' }
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

  override async getMysqlClientPath(): Promise<string> {
    const configPath = await configManager.getBinaryPath('mysql')
    if (configPath) return configPath

    throw new Error(
      'mysql client not found. Ensure MySQL binaries are downloaded:\n' +
        '  spindb engines download mysql',
    )
  }

  override async getMysqladminPath(): Promise<string> {
    const cfg = await configManager.getBinaryPath('mysqladmin')
    if (cfg) return cfg

    throw new Error(
      'mysqladmin not found. Ensure MySQL binaries are downloaded:\n' +
        '  spindb engines download mysql',
    )
  }

  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || container.database || 'mysql'

    const mysql = await this.getMysqlClientPath()

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

    const mysql = await this.getMysqlClientPath()

    try {
      const cmd = buildMysqlInlineCommand(
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

    const mysql = await this.getMysqlClientPath()

    try {
      const cmd = buildMysqlInlineCommand(
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
      const mysql = await this.getMysqlClientPath()

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
        logDebug('Executing mysqldump command', { cmd: safeCmd })
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
          reject(new Error(stderr || `mysqldump exited with code ${code}`))
        }
      })
    })
  }

  private async getDumpPath(): Promise<string> {
    const configPath = await configManager.getBinaryPath('mysqldump')
    if (configPath) return configPath

    throw new Error(
      'mysqldump not found. Ensure MySQL binaries are downloaded:\n' +
        '  spindb engines download mysql',
    )
  }

  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container
    const db = options.database || container.database || 'mysql'
    assertValidDatabaseName(db)

    const mysql = await this.getMysqlClientPath()

    if (isWindows()) {
      const cmd = buildWindowsMysqlCommand(
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
        throw new Error(`mysql client failed: ${err.message}`)
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
            reject(new Error(`mysql client exited with code ${code}`))
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
            reject(new Error(`mysql client exited with code ${code}`))
          }
        })
      })
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }
}

export const mysqlEngine = new MySQLEngine()
