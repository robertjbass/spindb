/**
 * MySQL Engine implementation
 * Manages MySQL database containers using system-installed MySQL binaries
 */

import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import {
  logDebug,
  logWarning,
  ErrorCodes,
  SpinDBError,
} from '../../core/error-handler'
import {
  getMysqldPath,
  getMysqlClientPath,
  getMysqladminPath,
  getMysqldumpPath,
  getMysqlInstallDbPath,
  getMariadbInstallDbPath,
  isMariaDB,
  detectInstalledVersions,
  getInstallInstructions,
} from './binary-detection'
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

// Re-export modules for external access
export * from './version-validator'
export * from './restore'

const execAsync = promisify(exec)

const ENGINE = 'mysql'
const engineDef = getEngineDefaults(ENGINE)

export class MySQLEngine extends BaseEngine {
  name = ENGINE
  displayName = 'MySQL'
  defaultPort = engineDef.defaultPort
  supportedVersions = engineDef.supportedVersions

  /**
   * Fetch available versions from system
   * Unlike PostgreSQL which downloads binaries, MySQL uses system-installed versions
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    const installed = await detectInstalledVersions()
    const versions: Record<string, string[]> = {}

    for (const [major, full] of Object.entries(installed)) {
      versions[major] = [full]
    }

    // If no versions found, return supported versions as placeholders
    if (Object.keys(versions).length === 0) {
      for (const v of this.supportedVersions) {
        versions[v] = [v]
      }
    }

    return versions
  }

  /**
   * Get binary download URL - not applicable for MySQL (uses system binaries)
   */
  getBinaryUrl(_version: string, _platform: string, _arch: string): string {
    throw new Error(
      'MySQL uses system-installed binaries. ' + getInstallInstructions(),
    )
  }

  /**
   * Verify that MySQL binaries are available
   */
  async verifyBinary(_binPath: string): Promise<boolean> {
    const mysqld = await getMysqldPath()
    return mysqld !== null
  }

  /**
   * Check if MySQL is installed
   */
  async isBinaryInstalled(_version: string): Promise<boolean> {
    const mysqld = await getMysqldPath()
    return mysqld !== null
  }

  /**
   * Ensure MySQL binaries are available (just checks system installation)
   */
  async ensureBinaries(
    _version: string,
    _onProgress?: ProgressCallback,
  ): Promise<string> {
    const mysqld = await getMysqldPath()
    if (!mysqld) {
      throw new Error(getInstallInstructions())
    }
    return mysqld
  }

  /**
   * Initialize a new MySQL/MariaDB data directory
   * MySQL: mysqld --initialize-insecure --datadir={dir}
   * MariaDB: mysql_install_db --datadir={dir} --auth-root-authentication-method=normal
   */
  async initDataDir(
    containerName: string,
    _version: string,
    _options: Record<string, unknown> = {},
  ): Promise<string> {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: ENGINE,
    })

    // Create data directory if it doesn't exist
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true })
    }

    // Check if we're using MariaDB or MySQL
    const usingMariaDB = await isMariaDB()

    if (usingMariaDB) {
      // MariaDB uses mysql_install_db or mariadb-install-db
      const installDb =
        (await getMariadbInstallDbPath()) || (await getMysqlInstallDbPath())
      if (!installDb) {
        throw new Error(
          'MariaDB detected but mysql_install_db not found.\n' +
            'Install MariaDB server package which includes the initialization script.',
        )
      }

      // MariaDB initialization
      // --auth-root-authentication-method=normal allows passwordless root login via socket
      const args = [
        `--datadir=${dataDir}`,
        `--user=${process.env.USER || 'mysql'}`,
        '--auth-root-authentication-method=normal',
      ]

      return new Promise((resolve, reject) => {
        const proc = spawn(installDb, args, {
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
            resolve(dataDir)
          } else {
            reject(
              new Error(
                `MariaDB initialization failed with code ${code}: ${stderr || stdout}`,
              ),
            )
          }
        })

        proc.on('error', reject)
      })
    } else {
      // MySQL uses mysqld --initialize-insecure
      const mysqld = await getMysqldPath()
      if (!mysqld) {
        throw new Error(getInstallInstructions())
      }

      // MySQL initialization
      // --initialize-insecure creates root user without password (for local dev)
      const args = [
        '--initialize-insecure',
        `--datadir=${dataDir}`,
        `--user=${process.env.USER || 'mysql'}`,
      ]

      return new Promise((resolve, reject) => {
        const proc = spawn(mysqld, args, {
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
            resolve(dataDir)
          } else {
            reject(
              new Error(
                `MySQL initialization failed with code ${code}: ${stderr || stdout}`,
              ),
            )
          }
        })

        proc.on('error', reject)
      })
    }
  }

  /**
   * Start MySQL server
   * CLI wrapper: mysqld_safe --datadir={dir} --port={port} &
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, port } = container

    const mysqld = await getMysqldPath()
    if (!mysqld) {
      throw new Error(getInstallInstructions())
    }

    const dataDir = paths.getContainerDataPath(name, { engine: ENGINE })
    const logFile = paths.getContainerLogPath(name, { engine: ENGINE })
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })
    const socketFile = join(
      paths.getContainerPath(name, { engine: ENGINE }),
      'mysql.sock',
    )

    onProgress?.({ stage: 'starting', message: 'Starting MySQL...' })

    // Start mysqld directly in background
    // Note: We use --initialize-insecure during init which creates root without password
    // This allows passwordless local connections without --skip-grant-tables
    // (--skip-grant-tables disables TCP networking in MySQL 8+)
    const args = [
      `--datadir=${dataDir}`,
      `--port=${port}`,
      `--socket=${socketFile}`,
      `--pid-file=${pidFile}`,
      `--log-error=${logFile}`,
      '--bind-address=127.0.0.1',
    ]

    return new Promise((resolve, reject) => {
      const proc = spawn(mysqld, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      })

      proc.unref()

      // Give MySQL a moment to start
      setTimeout(async () => {
        // Write PID file manually since we're running detached
        try {
          await writeFile(pidFile, String(proc.pid))
        } catch (error) {
          // PID file might be written by mysqld itself
          logDebug(`Could not write PID file (mysqld may write it): ${error}`)
        }

        // Wait for MySQL to be ready
        let attempts = 0
        const maxAttempts = 30
        const checkInterval = 500

        const checkReady = async () => {
          attempts++
          try {
            const mysqladmin = await getMysqladminPath()
            if (mysqladmin) {
              await execAsync(
                `"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`,
              )
              resolve({
                port,
                connectionString: this.getConnectionString(container),
              })
              return
            }
          } catch {
            if (attempts < maxAttempts) {
              setTimeout(checkReady, checkInterval)
            } else {
              reject(new Error('MySQL failed to start within timeout'))
            }
          }
        }

        checkReady()
      }, 1000)

      proc.on('error', reject)
    })
  }

  /**
   * Stop MySQL server
   * CLI wrapper: mysqladmin -u root -P {port} shutdown
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, port } = container
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })

    logDebug(`Stopping MySQL container "${name}" on port ${port}`)

    // Step 1: Get PID with validation
    const pid = await this.getValidatedPid(pidFile)
    if (pid === null) {
      // No valid PID file - check if process might still be running on port
      logDebug('No valid PID, checking if MySQL is responding on port')
      const mysqladmin = await getMysqladminPath()
      if (mysqladmin) {
        try {
          await execAsync(
            `"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`,
            { timeout: 2000 },
          )
          // MySQL is responding - try graceful shutdown even without PID
          logWarning(`MySQL responding on port ${port} but no valid PID file`)
          await this.gracefulShutdown(port)
        } catch {
          // MySQL not responding, nothing to stop
          logDebug('MySQL not responding, nothing to stop')
        }
      }
      return
    }

    // Step 2: Try graceful shutdown
    const gracefulSuccess = await this.gracefulShutdown(port, pid)
    if (gracefulSuccess) {
      await this.cleanupPidFile(pidFile)
      logDebug('MySQL stopped gracefully')
      return
    }

    // Step 3: Force kill with escalation
    await this.forceKillWithEscalation(pid, pidFile)
  }

  /**
   * Get and validate PID from PID file
   * Returns null if PID file doesn't exist, is corrupt, or references dead process
   */
  private async getValidatedPid(pidFile: string): Promise<number | null> {
    if (!existsSync(pidFile)) {
      logDebug('PID file does not exist')
      return null
    }

    try {
      const content = await readFile(pidFile, 'utf8')
      const pid = parseInt(content.trim(), 10)

      if (isNaN(pid) || pid <= 0) {
        logWarning(`PID file contains invalid value: "${content.trim()}"`, {
          code: ErrorCodes.PID_FILE_CORRUPT,
          pidFile,
        })
        // Clean up corrupt PID file
        await this.cleanupPidFile(pidFile)
        return null
      }

      // Verify process exists
      try {
        process.kill(pid, 0) // Signal 0 = check existence
        logDebug(`Validated PID ${pid}`)
        return pid
      } catch {
        logWarning(`PID file references non-existent process ${pid}`, {
          code: ErrorCodes.PID_FILE_STALE,
          pidFile,
        })
        // Clean up stale PID file
        await this.cleanupPidFile(pidFile)
        return null
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        logWarning(`Failed to read PID file: ${e.message}`, {
          pidFile,
          errorCode: e.code,
        })
      }
      return null
    }
  }

  /**
   * Attempt graceful shutdown via mysqladmin
   */
  private async gracefulShutdown(
    port: number,
    pid?: number,
    timeoutMs = 10000,
  ): Promise<boolean> {
    const mysqladmin = await getMysqladminPath()

    if (mysqladmin) {
      try {
        logDebug('Attempting mysqladmin shutdown')
        await execAsync(
          `"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root shutdown`,
          { timeout: 5000 },
        )
      } catch (err) {
        const e = err as Error
        logDebug(`mysqladmin shutdown failed: ${e.message}`)
        // Continue to wait for process to die or send SIGTERM
      }
    } else if (pid) {
      // No mysqladmin available, send SIGTERM
      logDebug('No mysqladmin available, sending SIGTERM')
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Process may already be dead
        return true
      }
    }

    // Wait for process to terminate
    if (pid) {
      const startTime = Date.now()
      const checkIntervalMs = 200

      while (Date.now() - startTime < timeoutMs) {
        try {
          process.kill(pid, 0)
          await this.sleep(checkIntervalMs)
        } catch {
          // Process is gone
          logDebug(`Process ${pid} terminated after graceful shutdown`)
          return true
        }
      }

      logDebug(`Graceful shutdown timed out after ${timeoutMs}ms`)
      return false
    }

    // No PID to check, assume success if mysqladmin didn't throw
    return true
  }

  /**
   * Force kill with signal escalation (SIGTERM -> SIGKILL)
   */
  private async forceKillWithEscalation(
    pid: number,
    pidFile: string,
  ): Promise<void> {
    logWarning(`Graceful shutdown failed, force killing process ${pid}`)

    // Try SIGTERM first (if not already sent in graceful shutdown)
    try {
      process.kill(pid, 'SIGTERM')
      await this.sleep(2000)

      // Check if still running
      try {
        process.kill(pid, 0)
      } catch {
        // Process terminated
        logDebug(`Process ${pid} terminated after SIGTERM`)
        await this.cleanupPidFile(pidFile)
        return
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ESRCH') {
        // Process already dead
        await this.cleanupPidFile(pidFile)
        return
      }
      logDebug(`SIGTERM failed: ${e.message}`)
    }

    // Escalate to SIGKILL
    logWarning(`SIGTERM failed, escalating to SIGKILL for process ${pid}`)
    try {
      process.kill(pid, 'SIGKILL')
      await this.sleep(1000)

      // Verify process is gone
      try {
        process.kill(pid, 0)
        // Process still running after SIGKILL - this is unexpected
        throw new SpinDBError(
          ErrorCodes.PROCESS_STOP_TIMEOUT,
          `Failed to stop MySQL process ${pid} even with SIGKILL`,
          'error',
          `Try manually killing the process: kill -9 ${pid}`,
        )
      } catch (checkErr) {
        const checkE = checkErr as NodeJS.ErrnoException
        if (checkE instanceof SpinDBError) throw checkE
        // Process is gone (ESRCH)
        logDebug(`Process ${pid} terminated after SIGKILL`)
        await this.cleanupPidFile(pidFile)
      }
    } catch (err) {
      if (err instanceof SpinDBError) throw err
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ESRCH') {
        // Process already dead
        await this.cleanupPidFile(pidFile)
        return
      }
      logDebug(`SIGKILL failed: ${e.message}`)
    }
  }

  /**
   * Clean up PID file
   */
  private async cleanupPidFile(pidFile: string): Promise<void> {
    try {
      await unlink(pidFile)
      logDebug('PID file cleaned up')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        logDebug(`Failed to clean up PID file: ${e.message}`)
      }
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Get MySQL server status
   */
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, port } = container
    const pidFile = paths.getContainerPidPath(name, { engine: ENGINE })

    // Check if PID file exists
    if (!existsSync(pidFile)) {
      return { running: false, message: 'MySQL is not running' }
    }

    // Try to ping MySQL
    const mysqladmin = await getMysqladminPath()
    if (mysqladmin) {
      try {
        await execAsync(`"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`)
        return { running: true, message: 'MySQL is running' }
      } catch {
        return { running: false, message: 'MySQL is not responding' }
      }
    }

    // Fall back to checking PID
    try {
      const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
      process.kill(pid, 0) // Check if process exists
      return { running: true, message: `MySQL is running (PID: ${pid})` }
    } catch {
      return { running: false, message: 'MySQL is not running' }
    }
  }

  /**
   * Detect backup format
   * Delegates to restore.ts module
   */
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormatImpl(filePath)
  }

  /**
   * Restore a backup
   * Delegates to restore.ts module with version validation
   * CLI wrapper: mysql -h 127.0.0.1 -P {port} -u root {db} < {file}
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: Record<string, unknown> = {},
  ): Promise<RestoreResult> {
    const { port } = container
    const database = (options.database as string) || container.database

    // Create the database if it doesn't exist
    if (options.createDatabase !== false) {
      await this.createDatabase(container, database)
    }

    // Use the restore module with version validation
    return restoreBackup(backupPath, {
      port,
      database,
      user: engineDef.superuser,
      createDatabase: false, // Already created above
      validateVersion: options.validateVersion !== false,
    })
  }

  /**
   * Get connection string
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'mysql'
    return `mysql://${engineDef.superuser}@127.0.0.1:${port}/${db}`
  }

  /**
   * Open mysql interactive shell
   * Spawn interactive: mysql -h 127.0.0.1 -P {port} -u root {db}
   */
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || container.database || 'mysql'

    const mysql = await getMysqlClientPath()
    if (!mysql) {
      throw new Error(
        'mysql client not found. Install MySQL client tools:\n' +
          '  macOS: brew install mysql-client\n' +
          '  Ubuntu/Debian: sudo apt install mysql-client',
      )
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        mysql,
        ['-h', '127.0.0.1', '-P', String(port), '-u', engineDef.superuser, db],
        { stdio: 'inherit' },
      )

      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
  }

  /**
   * Create a new database
   * CLI wrapper: mysql -h 127.0.0.1 -P {port} -u root -e 'CREATE DATABASE `{db}`'
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const mysql = await getMysqlClientPath()
    if (!mysql) {
      throw new Error(
        'mysql client not found. Install MySQL client tools:\n' +
          '  macOS: brew install mysql-client\n' +
          '  Ubuntu/Debian: sudo apt install mysql-client',
      )
    }

    try {
      // Use backticks for MySQL database names
      await execAsync(
        `"${mysql}" -h 127.0.0.1 -P ${port} -u ${engineDef.superuser} -e 'CREATE DATABASE IF NOT EXISTS \`${database}\`'`,
      )
    } catch (error) {
      const err = error as Error
      // Ignore "database exists" error
      if (!err.message.includes('database exists')) {
        throw error
      }
    }
  }

  /**
   * Drop a database
   * CLI wrapper: mysql -h 127.0.0.1 -P {port} -u root -e 'DROP DATABASE IF EXISTS `{db}`'
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container

    const mysql = await getMysqlClientPath()
    if (!mysql) {
      throw new Error('mysql client not found.')
    }

    try {
      await execAsync(
        `"${mysql}" -h 127.0.0.1 -P ${port} -u ${engineDef.superuser} -e 'DROP DATABASE IF EXISTS \`${database}\`'`,
      )
    } catch (error) {
      const err = error as Error
      if (!err.message.includes("database doesn't exist")) {
        throw error
      }
    }
  }

  /**
   * Get the size of the container's database in bytes
   * Uses information_schema.tables to sum data_length + index_length
   * Returns null if container is not running or query fails
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, database } = container
    const db = database || 'mysql'

    try {
      const mysql = await getMysqlClientPath()
      if (!mysql) return null

      // Query information_schema for total data + index size
      const { stdout } = await execAsync(
        `"${mysql}" -h 127.0.0.1 -P ${port} -u ${engineDef.superuser} -N -e "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = '${db}'"`,
      )
      const size = parseInt(stdout.trim(), 10)
      return isNaN(size) ? null : size
    } catch {
      // Container not running or query failed
      return null
    }
  }

  /**
   * Create a dump from a remote database using a connection string
   * CLI wrapper: mysqldump -h {host} -P {port} -u {user} -p{pass} {db} > {file}
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const mysqldump = await getMysqldumpPath()
    if (!mysqldump) {
      throw new Error(
        'mysqldump not found. Install MySQL client tools:\n' +
          '  macOS: brew install mysql-client\n' +
          '  Ubuntu/Debian: sudo apt install mysql-client',
      )
    }

    // Parse MySQL connection string using restore module helper
    const { host, port, user, password, database } =
      parseConnectionString(connectionString)

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

    return new Promise((resolve, reject) => {
      const proc = spawn(mysqldump, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
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

  /**
   * Create a backup of a MySQL database
   */
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    return createBackup(container, outputPath, options)
  }

  /**
   * Run a SQL file or inline SQL statement against the database
   * CLI wrapper: mysql -h 127.0.0.1 -P {port} -u root {db} < {file}
   * CLI wrapper: mysql -h 127.0.0.1 -P {port} -u root {db} -e "{sql}"
   */
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container
    const db = options.database || container.database || 'mysql'

    const mysql = await getMysqlClientPath()
    if (!mysql) {
      throw new Error(
        'mysql client not found. Install MySQL client tools:\n' +
          '  macOS: brew install mysql-client\n' +
          '  Ubuntu/Debian: sudo apt install mysql-client',
      )
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
      // For inline SQL, use -e flag
      args.push('-e', options.sql)
      return new Promise((resolve, reject) => {
        const proc = spawn(mysql, args, { stdio: 'inherit' })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`mysql exited with code ${code}`))
          }
        })
      })
    } else if (options.file) {
      // For file input, pipe the file to mysql stdin
      const { createReadStream } = await import('fs')

      return new Promise((resolve, reject) => {
        const fileStream = createReadStream(options.file!)
        const proc = spawn(mysql, args, {
          stdio: ['pipe', 'inherit', 'inherit'],
        })

        fileStream.pipe(proc.stdin)

        fileStream.on('error', (err) => {
          proc.kill()
          reject(err)
        })

        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`mysql exited with code ${code}`))
          }
        })
      })
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }
}

export const mysqlEngine = new MySQLEngine()
