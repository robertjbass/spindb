import { join } from 'path'
import { spawn, exec, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { BaseEngine } from '../base-engine'
import { binaryManager } from '../../core/binary-manager'
import { processManager } from '../../core/process-manager'
import { configManager } from '../../core/config-manager'
import {
  platformService,
  isWindows,
  getWindowsSpawnOptions,
} from '../../core/platform-service'
import {
  detectPackageManager,
  installEngineDependencies,
  findBinary,
} from '../../core/dependency-manager'
import { paths } from '../../config/paths'
import { defaults, getEngineDefaults } from '../../config/defaults'
import { getPostgresHomebrewBinPath } from '../../config/engine-defaults'
import {
  getBinaryUrl,
  SUPPORTED_MAJOR_VERSIONS,
  fetchAvailableVersions,
  getLatestVersion,
  FALLBACK_VERSION_MAP,
} from './binary-urls'
import { detectBackupFormat, restoreBackup } from './restore'
import { createBackup } from './backup'
import { assertValidDatabaseName } from '../../core/error-handler'
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

/**
 * Build a Windows-safe psql command string for either a file or inline SQL.
 * This is exported for unit testing.
 */
export function buildWindowsPsqlCommand(
  psqlPath: string,
  port: number,
  user: string,
  db: string,
  options: { file?: string; sql?: string },
): string {
  if (!options.file && !options.sql) {
    throw new Error('Either file or sql option must be provided')
  }

  let cmd = `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${user} -d ${db}`

  if (options.file) {
    cmd += ` -f "${options.file}"`
  } else if (options.sql) {
    // Escape double quotes in the SQL so the outer double quotes are preserved
    const escaped = options.sql.replace(/"/g, '\\"')
    cmd += ` -c "${escaped}"`
  }

  return cmd
}

export class PostgreSQLEngine extends BaseEngine {
  name = 'postgresql'
  displayName = 'PostgreSQL'
  defaultPort = 5432
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

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

  // Resolves version string to full version (e.g., '17' -> '17.7.0').
  resolveFullVersion(version: string): string {
    // Check if already a full version (has at least one dot with numbers after)
    if (/^\d+\.\d+/.test(version)) {
      return version
    }
    // It's a major version, resolve using fallback map (sync, no network)
    return FALLBACK_VERSION_MAP[version] || `${version}.0.0`
  }

  async resolveFullVersionAsync(version: string): Promise<string> {
    // Check if already a full version
    if (/^\d+\.\d+/.test(version)) {
      return version
    }
    // Resolve from network/cache
    return getLatestVersion(version)
  }

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

  getBinaryUrl(version: string, plat: string, arc: string): string {
    return getBinaryUrl(version, plat, arc)
  }

  async verifyBinary(binPath: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    // Extract version from path
    const parts = binPath.split('-')
    const version = parts[1]
    return binaryManager.verify(version, p, a)
  }

  // Also registers client tools (psql, pg_dump, etc.) in config after download.
  // On macOS/Linux where zonky.io binaries don't include client tools,
  // installs them via system package manager (Homebrew on macOS, apt on Linux).
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    const binPath = await binaryManager.ensureInstalled(
      version,
      p,
      a,
      onProgress,
    )

    // Register client tools from downloaded binaries in config
    // This ensures dependency checks find them without requiring system installation
    const ext = platformService.getExecutableExtension()
    const clientTools = [
      'psql',
      'pg_dump',
      'pg_restore',
      'pg_basebackup',
    ] as const

    // First, try to register from downloaded binaries (works on Windows)
    let hasClientTools = false
    for (const tool of clientTools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
        hasClientTools = true
      }
    }

    // On macOS, zonky.io binaries don't include client tools
    // Install them via Homebrew and register from there
    if (!hasClientTools && p === 'darwin') {
      await this.ensureMacOSClientTools(a, onProgress)
    }

    return binPath
  }

  /**
   * Ensure PostgreSQL client tools are available on macOS
   * Installs via Homebrew if missing, then registers paths in config
   */
  private async ensureMacOSClientTools(
    arch: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const clientTools = ['psql', 'pg_dump', 'pg_restore', 'pg_basebackup'] as const

    // Check if psql is already available (either from Homebrew or system)
    const psqlResult = await findBinary('psql')
    if (psqlResult) {
      // Client tools already available, register all of them
      for (const tool of clientTools) {
        const result = await findBinary(tool)
        if (result) {
          await configManager.setBinaryPath(tool, result.path, 'system')
        }
      }
      return
    }

    // Need to install client tools via Homebrew
    onProgress?.({
      stage: 'installing',
      message: 'Installing PostgreSQL client tools via Homebrew...',
    })

    const packageManager = await detectPackageManager()
    if (!packageManager) {
      throw new Error(
        'Homebrew not found. Install PostgreSQL client tools manually:\n' +
          '  brew install postgresql@17 && brew link --overwrite postgresql@17',
      )
    }

    // Install PostgreSQL via Homebrew (only installs if missing)
    await installEngineDependencies('postgresql', packageManager)

    // After installation, register tool paths from Homebrew location
    const homebrewArch = arch === 'arm64' ? 'arm64' : 'x64'
    const homebrewBinPath = getPostgresHomebrewBinPath(homebrewArch)

    for (const tool of clientTools) {
      const toolPath = join(homebrewBinPath, tool)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'system')
      } else {
        // Fallback: try to find via PATH
        const result = await findBinary(tool)
        if (result) {
          await configManager.setBinaryPath(tool, result.path, 'system')
        }
      }
    }

    onProgress?.({
      stage: 'complete',
      message: 'PostgreSQL client tools installed',
    })
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return binaryManager.isInstalled(version, p, a)
  }

  async initDataDir(
    containerName: string,
    version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const binPath = this.getBinaryPath(version)
    const ext = platformService.getExecutableExtension()
    const initdbPath = join(binPath, 'bin', `initdb${ext}`)
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: this.name,
    })

    await processManager.initdb(initdbPath, dataDir, {
      superuser: (options.superuser as string) || defaults.superuser,
    })

    // Configure max_connections after initdb creates postgresql.conf
    const maxConnections =
      (options.maxConnections as number) ||
      getEngineDefaults('postgresql').maxConnections
    await this.setConfigValue(
      dataDir,
      'max_connections',
      String(maxConnections),
    )

    return dataDir
  }

  getConfigPath(containerName: string): string {
    const dataDir = paths.getContainerDataPath(containerName, {
      engine: this.name,
    })
    return join(dataDir, 'postgresql.conf')
  }

  // Updates or appends a configuration value in postgresql.conf.
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

  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const { name, version, port } = container
    const binPath = this.getBinaryPath(version)
    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(binPath, 'bin', `pg_ctl${ext}`)
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

  async stop(container: ContainerConfig): Promise<void> {
    const { name, version } = container
    const binPath = this.getBinaryPath(version)
    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(binPath, 'bin', `pg_ctl${ext}`)
    const dataDir = paths.getContainerDataPath(name, { engine: this.name })

    await processManager.stop(pgCtlPath, dataDir)
  }

  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, version } = container
    const binPath = this.getBinaryPath(version)
    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(binPath, 'bin', `pg_ctl${ext}`)
    const dataDir = paths.getContainerDataPath(name, { engine: this.name })

    return processManager.status(pgCtlPath, dataDir)
  }

  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    return detectBackupFormat(filePath)
  }

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

  getConnectionString(container: ContainerConfig, database?: string): string {
    const { port } = container
    const db = database || container.database || 'postgres'
    return `postgresql://${defaults.superuser}@127.0.0.1:${port}/${db}`
  }

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

  async connect(container: ContainerConfig, database?: string): Promise<void> {
    const { port } = container
    const db = database || 'postgres'
    const psqlPath = await this.getPsqlPath()

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
      ...getWindowsSpawnOptions(),
    }

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
        spawnOptions,
      )

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', () => resolve())
    })
  }

  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    // On Windows, single quotes don't work in cmd.exe - use double quotes and escape inner quotes
    const sql = `CREATE DATABASE "${database}"`
    const cmd = isWindows()
      ? `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c "${sql.replace(/"/g, '\\"')}"`
      : `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c '${sql}'`

    try {
      await execAsync(cmd)
    } catch (error) {
      const err = error as Error
      // Ignore "database already exists" error
      if (!err.message.includes('already exists')) {
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
    const psqlPath = await this.getPsqlPath()

    // On Windows, single quotes don't work in cmd.exe - use double quotes and escape inner quotes
    const sql = `DROP DATABASE IF EXISTS "${database}"`
    const cmd = isWindows()
      ? `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c "${sql.replace(/"/g, '\\"')}"`
      : `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c '${sql}'`

    try {
      await execAsync(cmd)
    } catch (error) {
      const err = error as Error
      // Ignore "database does not exist" error
      if (!err.message.includes('does not exist')) {
        throw error
      }
    }
  }

  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const { port, database } = container
    const db = database || 'postgres'

    // Validate database name to prevent SQL injection
    assertValidDatabaseName(db)

    try {
      const psqlPath = await this.getPsqlPath()
      // Query pg_database_size for the specific database
      // On Windows, use escaped double quotes; on Unix, use single quotes
      const sql = `SELECT pg_database_size('${db}')`
      const cmd = isWindows()
        ? `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -t -A -c "${sql.replace(/'/g, "''")}"`
        : `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -t -A -c "${sql}"`
      const { stdout } = await execAsync(cmd)
      const size = parseInt(stdout.trim(), 10)
      return isNaN(size) ? null : size
    } catch {
      // Container not running or query failed
      return null
    }
  }

  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    const pgDumpPath = await this.getPgDumpPath()

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...getWindowsSpawnOptions(),
    }

    return new Promise((resolve, reject) => {
      const args = [connectionString, '-Fc', '-f', outputPath]

      const proc = spawn(pgDumpPath, args, spawnOptions)

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
    const db = options.database || container.database || 'postgres'
    const psqlPath = await this.getPsqlPath()

    // On Windows, build a single command string and use exec to avoid
    // passing an args array with shell:true (DEP0190 and quoting issues).
    if (isWindows()) {
      const cmd = buildWindowsPsqlCommand(
        psqlPath,
        port,
        defaults.superuser,
        db,
        options,
      )
      try {
        await execAsync(cmd)
        return
      } catch (error) {
        const err = error as Error
        throw new Error(`psql failed: ${err.message}`)
      }
    }

    // Non-Windows: spawn directly with args (no shell)
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

    const spawnOptions: SpawnOptions = {
      stdio: 'inherit',
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(psqlPath, args, spawnOptions)

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
