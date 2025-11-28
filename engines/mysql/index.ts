/**
 * MySQL Engine implementation
 * Manages MySQL database containers using system-installed MySQL binaries
 */

import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { existsSync, createReadStream } from 'fs'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
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
import type {
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  RestoreResult,
  DumpResult,
  StatusResult,
} from '../../types'

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
    const dataDir = paths.getContainerDataPath(containerName, { engine: ENGINE })

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
        } catch {
          // PID file might be written by mysqld itself
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

    // Try graceful shutdown first with mysqladmin
    const mysqladmin = await getMysqladminPath()
    if (mysqladmin) {
      try {
        await execAsync(
          `"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root shutdown`,
        )
      } catch {
        // Fall back to killing the process
        if (existsSync(pidFile)) {
          try {
            const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
            process.kill(pid, 'SIGTERM')
          } catch {
            // Process might already be dead
          }
        }
      }
    } else if (existsSync(pidFile)) {
      // No mysqladmin, kill by PID
      try {
        const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
        process.kill(pid, 'SIGTERM')
      } catch {
        // Process might already be dead
      }
    }

    // Wait for the process to actually stop
    const maxWaitMs = 10000
    const checkIntervalMs = 200
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      // Check if PID file is gone or process is dead
      if (!existsSync(pidFile)) {
        return
      }

      try {
        const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
        // Check if process is still running (signal 0 doesn't kill, just checks)
        process.kill(pid, 0)
        // Process still running, wait a bit
        await new Promise((resolve) => setTimeout(resolve, checkIntervalMs))
      } catch {
        // Process is dead, remove stale PID file if it exists
        try {
          await rm(pidFile, { force: true })
        } catch {
          // Ignore
        }
        return
      }
    }

    // Timeout - force kill if still running
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
        process.kill(pid, 'SIGKILL')
        await rm(pidFile, { force: true })
      } catch {
        // Ignore
      }
    }
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
        await execAsync(
          `"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`,
        )
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
   * MySQL dumps are typically SQL files
   */
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    // Read first few bytes to detect format
    const buffer = Buffer.alloc(64)
    const { open } = await import('fs/promises')
    const file = await open(filePath, 'r')
    await file.read(buffer, 0, 64, 0)
    await file.close()

    const header = buffer.toString('utf8')

    // Check for MySQL dump markers
    if (
      header.includes('-- MySQL dump') ||
      header.includes('-- MariaDB dump')
    ) {
      return {
        format: 'sql',
        description: 'MySQL SQL dump',
        restoreCommand: 'mysql',
      }
    }

    // Default to SQL format
    return {
      format: 'sql',
      description: 'SQL file',
      restoreCommand: 'mysql',
    }
  }

  /**
   * Restore a backup
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

    const mysql = await getMysqlClientPath()
    if (!mysql) {
      throw new Error(
        'mysql client not found. Install MySQL client tools:\n' +
          '  macOS: brew install mysql-client\n' +
          '  Ubuntu/Debian: sudo apt install mysql-client',
      )
    }

    // Restore using mysql client
    // CLI: mysql -h 127.0.0.1 -P {port} -u root {db} < {file}
    return new Promise((resolve, reject) => {
      const args = [
        '-h',
        '127.0.0.1',
        '-P',
        String(port),
        '-u',
        engineDef.superuser,
        database,
      ]

      const proc = spawn(mysql, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Pipe backup file to stdin
      const fileStream = createReadStream(backupPath)
      fileStream.pipe(proc.stdin)

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        resolve({
          format: 'sql',
          stdout,
          stderr,
          code: code ?? undefined,
        })
      })

      proc.on('error', reject)
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

    // Parse MySQL connection string: mysql://user:pass@host:port/dbname
    const url = new URL(connectionString)
    const host = url.hostname
    const port = url.port || '3306'
    const user = url.username || 'root'
    const password = url.password
    const database = url.pathname.slice(1) // Remove leading /

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
}

export const mysqlEngine = new MySQLEngine()
