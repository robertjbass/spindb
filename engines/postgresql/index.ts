import { join } from 'path'
import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile } from 'fs/promises'
import { BaseEngine } from '../base-engine'
import { binaryManager } from '../../core/binary-manager'
import { processManager } from '../../core/process-manager'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { defaults, getEngineDefaults } from '../../config/defaults'
import {
  getBinaryUrl,
  SUPPORTED_MAJOR_VERSIONS,
  fetchAvailableVersions,
  getLatestVersion,
  FALLBACK_VERSION_MAP,
} from './binary-urls'
import { detectBackupFormat, restoreBackup } from './restore'
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

export class PostgreSQLEngine extends BaseEngine {
  name = 'postgresql'
  displayName = 'PostgreSQL'
  defaultPort = 5432
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  /**
   * Fetch all available versions from Maven (grouped by major version)
   * Falls back to hardcoded versions if network fails
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchAvailableVersions()
  }

  /**
   * Get current platform info
   */
  getPlatformInfo(): { platform: string; arch: string } {
    const info = platformService.getPlatformInfo()
    return {
      platform: info.platform,
      arch: info.arch,
    }
  }

  /**
   * Resolve a version string to a full version.
   * If given a major version like '17', resolves to '17.7.0'.
   * If already a full version like '17.7.0', returns as-is.
   */
  resolveFullVersion(version: string): string {
    // Check if already a full version (has at least one dot with numbers after)
    if (/^\d+\.\d+/.test(version)) {
      return version
    }
    // It's a major version, resolve using fallback map (sync, no network)
    return FALLBACK_VERSION_MAP[version] || `${version}.0.0`
  }

  /**
   * Resolve version asynchronously (tries network first for latest)
   */
  async resolveFullVersionAsync(version: string): Promise<string> {
    // Check if already a full version
    if (/^\d+\.\d+/.test(version)) {
      return version
    }
    // Resolve from network/cache
    return getLatestVersion(version)
  }

  /**
   * Get binary path for current platform
   * Uses full version for directory naming (e.g., postgresql-17.7.0-darwin-arm64)
   */
  getBinaryPath(version: string): string {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: p,
      arch: a,
    })
  }

  /**
   * Get binary download URL
   */
  getBinaryUrl(version: string, plat: string, arc: string): string {
    return getBinaryUrl(version, plat, arc)
  }

  /**
   * Verify binary installation
   */
  async verifyBinary(binPath: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    // Extract version from path
    const parts = binPath.split('-')
    const version = parts[1]
    return binaryManager.verify(version, p, a)
  }

  /**
   * Ensure PostgreSQL binaries are available
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return binaryManager.ensureInstalled(version, p, a, onProgress)
  }

  /**
   * Check if binaries are installed
   */
  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return binaryManager.isInstalled(version, p, a)
  }

  /**
   * Initialize a new PostgreSQL data directory
   */
  async initDataDir(
    containerName: string,
    version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const binPath = this.getBinaryPath(version)
    const initdbPath = join(binPath, 'bin', 'initdb')
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: this.name,
    })

    await processManager.initdb(initdbPath, dataDir, {
      superuser: (options.superuser as string) || defaults.superuser,
    })

    // Configure max_connections after initdb creates postgresql.conf
    const maxConnections =
      (options.maxConnections as number) || getEngineDefaults('postgresql').maxConnections
    await this.setConfigValue(dataDir, 'max_connections', String(maxConnections))

    return dataDir
  }

  /**
   * Get the path to postgresql.conf for a container
   */
  getConfigPath(containerName: string): string {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: this.name,
    })
    return join(dataDir, 'postgresql.conf')
  }

  /**
   * Set a configuration value in postgresql.conf
   * If the setting exists (commented or not), it updates the line.
   * If not found, appends it to the end of the file.
   */
  async setConfigValue(
    dataDir: string,
    key: string,
    value: string,
  ): Promise<void> {
    const configPath = join(dataDir, 'postgresql.conf')
    let content = await readFile(configPath, 'utf8')

    // Match both commented (#key = ...) and uncommented (key = ...) lines
    const regex = new RegExp(`^#?\\s*${key}\\s*=.*$`, 'm')

    if (regex.test(content)) {
      // Update existing line (commented or not)
      content = content.replace(regex, `${key} = ${value}`)
    } else {
      // Append to end of file
      content = content.trimEnd() + `\n${key} = ${value}\n`
    }

    await writeFile(configPath, content, 'utf8')
  }

  /**
   * Get a configuration value from postgresql.conf
   * Returns null if not found or commented out
   */
  async getConfigValue(dataDir: string, key: string): Promise<string | null> {
    const configPath = join(dataDir, 'postgresql.conf')
    const content = await readFile(configPath, 'utf8')

    // Match only uncommented lines
    const regex = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, 'm')
    const match = content.match(regex)

    if (match) {
      // Remove quotes if present
      return match[1].replace(/^['"]|['"]$/g, '')
    }
    return null
  }

  /**
   * Start PostgreSQL server
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, version, port } = container
    const binPath = this.getBinaryPath(version)
    const pgCtlPath = join(binPath, 'bin', 'pg_ctl')
    const dataDir = paths.getContainerDataPath(name, { engine: this.name })
    const logFile = paths.getContainerLogPath(name, { engine: this.name })

    onProgress?.({ stage: 'starting', message: 'Starting PostgreSQL...' })

    await processManager.start(pgCtlPath, dataDir, {
      port,
      logFile,
    })

    return {
      port,
      connectionString: this.getConnectionString(container),
    }
  }

  /**
   * Stop PostgreSQL server
   */
  async stop(container: ContainerConfig): Promise<void> {
    const { name, version } = container
    const binPath = this.getBinaryPath(version)
    const pgCtlPath = join(binPath, 'bin', 'pg_ctl')
    const dataDir = paths.getContainerDataPath(name, { engine: this.name })

    await processManager.stop(pgCtlPath, dataDir)
  }

  /**
   * Get PostgreSQL server status
   */
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, version } = container
    const binPath = this.getBinaryPath(version)
    const pgCtlPath = join(binPath, 'bin', 'pg_ctl')
    const dataDir = paths.getContainerDataPath(name, { engine: this.name })

    return processManager.status(pgCtlPath, dataDir)
  }

  /**
   * Detect backup format
   */
  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormat(filePath)
  }

  /**
   * Restore a backup
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options: Record<string, unknown> = {},
  ): Promise<RestoreResult> {
    const { version, port } = container
    const binPath = this.getBinaryPath(version)
    const database = (options.database as string) || container.name

    // First create the database if it doesn't exist
    if (options.createDatabase !== false) {
      await this.createDatabase(container, database)
    }

    return restoreBackup(binPath, backupPath, {
      port,
      database,
      user: defaults.superuser,
      pgRestorePath: options.pgRestorePath as string, // Use custom path if provided
      ...(options as { format?: string }),
    })
  }

  /**
   * Get connection string
   */
  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'postgres'
    return `postgresql://${defaults.superuser}@127.0.0.1:${port}/${db}`
  }

  /**
   * Get path to psql, using config manager to find it
   */
  async getPsqlPath(): Promise<string> {
    const psqlPath = await configManager.getBinaryPath('psql')
    if (!psqlPath) {
      throw new Error(
        'psql not found. Install PostgreSQL client tools:\n' +
          '  macOS: brew install libpq && brew link --force libpq\n' +
          '  Ubuntu/Debian: apt install postgresql-client\n\n' +
          'Or configure manually: spindb config set psql /path/to/psql',
      )
    }
    return psqlPath
  }

  /**
   * Get path to pg_restore, using config manager to find it
   */
  async getPgRestorePath(): Promise<string> {
    const pgRestorePath = await configManager.getBinaryPath('pg_restore')
    if (!pgRestorePath) {
      throw new Error(
        'pg_restore not found. Install PostgreSQL client tools:\n' +
          '  macOS: brew install libpq && brew link --force libpq\n' +
          '  Ubuntu/Debian: apt install postgresql-client\n\n' +
          'Or configure manually: spindb config set pg_restore /path/to/pg_restore',
      )
    }
    return pgRestorePath
  }

  /**
   * Get path to pg_dump, using config manager to find it
   */
  async getPgDumpPath(): Promise<string> {
    const pgDumpPath = await configManager.getBinaryPath('pg_dump')
    if (!pgDumpPath) {
      throw new Error(
        'pg_dump not found. Install PostgreSQL client tools:\n' +
          '  macOS: brew install libpq && brew link --force libpq\n' +
          '  Ubuntu/Debian: apt install postgresql-client\n\n' +
          'Or configure manually: spindb config set pg_dump /path/to/pg_dump',
      )
    }
    return pgDumpPath
  }

  /**
   * Open psql interactive shell
   */
  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || 'postgres'
    const psqlPath = await this.getPsqlPath()

    return new Promise((resolve, reject) => {
      const proc = spawn(
        psqlPath,
        [
          '-h',
          '127.0.0.1',
          '-p',
          String(port),
          '-U',
          defaults.superuser,
          '-d',
          db,
        ],
        { stdio: 'inherit' },
      )

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', () => resolve())
    })
  }

  /**
   * Create a new database
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    try {
      await execAsync(
        `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c 'CREATE DATABASE "${database}"'`,
      )
    } catch (error) {
      const err = error as Error
      // Ignore "database already exists" error
      if (!err.message.includes('already exists')) {
        throw error
      }
    }
  }

  /**
   * Drop a database
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    try {
      await execAsync(
        `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c 'DROP DATABASE IF EXISTS "${database}"'`,
      )
    } catch (error) {
      const err = error as Error
      // Ignore "database does not exist" error
      if (!err.message.includes('does not exist')) {
        throw error
      }
    }
  }

  /**
   * Get the size of the container's database in bytes
   * Uses pg_database_size() to get accurate data size
   * Returns null if container is not running or query fails
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, database } = container
    const db = database || 'postgres'

    try {
      const psqlPath = await this.getPsqlPath()
      // Query pg_database_size for the specific database
      const { stdout } = await execAsync(
        `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -t -A -c "SELECT pg_database_size('${db}')"`,
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
   * @param connectionString PostgreSQL connection string (e.g., postgresql://user:pass@host:port/dbname)
   * @param outputPath Path where the dump file will be saved
   * @returns DumpResult with file path and any output
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const pgDumpPath = await this.getPgDumpPath()

    return new Promise((resolve, reject) => {
      // Use custom format (-Fc) for best compatibility and compression
      const args = [connectionString, '-Fc', '-f', outputPath]

      const proc = spawn(pgDumpPath, args, {
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

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({
            filePath: outputPath,
            stdout,
            stderr,
            code,
          })
        } else {
          // pg_dump failed
          const errorMessage = stderr || `pg_dump exited with code ${code}`
          reject(new Error(errorMessage))
        }
      })
    })
  }

  /**
   * Create a backup of a PostgreSQL database
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
   * CLI wrapper: psql -h 127.0.0.1 -p {port} -U postgres -d {db} -f {file}
   * CLI wrapper: psql -h 127.0.0.1 -p {port} -U postgres -d {db} -c "{sql}"
   */
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const { port } = container
    const db = options.database || container.database || 'postgres'
    const psqlPath = await this.getPsqlPath()

    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      db,
    ]

    if (options.file) {
      args.push('-f', options.file)
    } else if (options.sql) {
      args.push('-c', options.sql)
    } else {
      throw new Error('Either file or sql option must be provided')
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(psqlPath, args, { stdio: 'inherit' })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`psql exited with code ${code}`))
        }
      })
    })
  }
}

export const postgresqlEngine = new PostgreSQLEngine()
