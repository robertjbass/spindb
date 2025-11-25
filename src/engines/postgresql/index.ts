import { platform, arch } from 'os'
import { join } from 'path'
import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { BaseEngine } from '@/engines/base-engine'
import { binaryManager } from '@/core/binary-manager'
import { processManager } from '@/core/process-manager'
import { configManager } from '@/core/config-manager'
import { paths } from '@/config/paths'
import { defaults } from '@/config/defaults'
import {
  getBinaryUrl,
  SUPPORTED_MAJOR_VERSIONS,
  fetchAvailableVersions,
} from './binary-urls'
import { detectBackupFormat, restoreBackup } from './restore'
import type {
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  RestoreResult,
  StatusResult,
} from '@/types'

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
    return {
      platform: platform(),
      arch: arch(),
    }
  }

  /**
   * Get binary path for current platform
   */
  getBinaryPath(version: string): string {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return paths.getBinaryPath('postgresql', version, p, a)
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
    const dataDir = paths.getContainerDataPath(containerName)

    await processManager.initdb(initdbPath, dataDir, {
      superuser: (options.superuser as string) || defaults.superuser,
    })

    return dataDir
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
    const dataDir = paths.getContainerDataPath(name)
    const logFile = paths.getContainerLogPath(name)

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
    const dataDir = paths.getContainerDataPath(name)

    await processManager.stop(pgCtlPath, dataDir)
  }

  /**
   * Get PostgreSQL server status
   */
  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, version } = container
    const binPath = this.getBinaryPath(version)
    const pgCtlPath = join(binPath, 'bin', 'pg_ctl')
    const dataDir = paths.getContainerDataPath(name)

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
}

export const postgresqlEngine = new PostgreSQLEngine()
