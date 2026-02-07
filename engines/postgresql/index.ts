import { join } from 'path'
import { spawn, exec, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { BaseEngine } from '../base-engine'
import { postgresqlBinaryManager } from './binary-manager'
import { processManager } from '../../core/process-manager'
import { configManager } from '../../core/config-manager'
import { containerManager } from '../../core/container-manager'
import {
  platformService,
  isWindows,
  getWindowsSpawnOptions,
} from '../../core/platform-service'
import { paths } from '../../config/paths'
import { defaults, getEngineDefaults } from '../../config/defaults'
import { getBinaryUrl } from './binary-urls'
import { fetchAvailableVersions, getLatestVersion } from './hostdb-releases'
import {
  SUPPORTED_MAJOR_VERSIONS,
  POSTGRESQL_VERSION_MAP,
} from './version-maps'
import { detectBackupFormat, restoreBackup } from './restore'
import { createBackup } from './backup'
import {
  validateDumpCompatibility,
  type DumpCompatibilityResult,
} from './version-validator'
import { switchHomebrewVersion } from '../../core/homebrew-version-manager'
import {
  assertValidDatabaseName,
  assertValidUsername,
  SpinDBError,
  ErrorCodes,
} from '../../core/error-handler'
import { parseCSVToQueryResult } from '../../core/query-parser'
import type {
  Platform,
  Arch,
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  BackupOptions,
  BackupResult,
  RestoreResult,
  DumpResult,
  StatusResult,
  QueryResult,
  QueryOptions,
  CreateUserOptions,
  UserCredentials,
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
  defaultPort = getEngineDefaults('postgresql').defaultPort
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

  // Resolves version string to full version (e.g., '17' -> '17.7.0').
  resolveFullVersion(version: string): string {
    // Check if already a full version (has at least one dot with numbers after)
    if (/^\d+\.\d+/.test(version)) {
      return version
    }
    // It's a major version, resolve using fallback map (sync, no network)
    return POSTGRESQL_VERSION_MAP[version] || `${version}.0.0`
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

  /**
   * Gets the binary path with self-healing fallback logic.
   *
   * If binaries for the exact version don't exist:
   * 1. Looks for any installed binaries with the same major version
   * 2. If found, uses those and optionally updates the container config
   * 3. If not found, downloads the current supported version for that major
   *
   * @param version - The version from container config (e.g., "17.7.0")
   * @param containerName - Container name for config updates (optional)
   * @param onProgress - Progress callback for downloads
   * @returns Object with binPath and actualVersion (may differ from requested)
   */
  async getBinaryPathWithFallback(
    version: string,
    containerName?: string,
    onProgress?: ProgressCallback,
  ): Promise<{ binPath: string; actualVersion: string; wasHealed: boolean }> {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()

    // Check if exact version binaries exist
    const expectedPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: p,
      arch: a,
    })

    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(expectedPath, 'bin', `pg_ctl${ext}`)

    if (existsSync(pgCtlPath)) {
      return {
        binPath: expectedPath,
        actualVersion: fullVersion,
        wasHealed: false,
      }
    }

    // Binaries don't exist - try to find same major version
    const majorVersion = fullVersion.split('.')[0]

    // Check if we have any installed binaries for this major version
    const installed = paths.findInstalledBinaryForMajor(
      'postgresql',
      majorVersion,
      p,
      a,
    )

    if (installed) {
      // Found compatible binaries - verify they work
      const installedPgCtl = join(installed.path, 'bin', `pg_ctl${ext}`)
      if (existsSync(installedPgCtl)) {
        // Update container config if container name provided
        if (containerName) {
          await containerManager.updateConfig(containerName, {
            version: installed.version,
          })
        }
        return {
          binPath: installed.path,
          actualVersion: installed.version,
          wasHealed: true,
        }
      }
    }

    // No compatible binaries found - download the current supported version
    const targetVersion = POSTGRESQL_VERSION_MAP[majorVersion]
    if (!targetVersion) {
      throw new Error(
        `PostgreSQL major version ${majorVersion} is not supported. ` +
          `Supported versions: ${SUPPORTED_MAJOR_VERSIONS.join(', ')}`,
      )
    }

    onProgress?.({
      stage: 'downloading',
      message: `Binaries for PostgreSQL ${fullVersion} not found, downloading ${targetVersion}...`,
    })

    const binPath = await this.ensureBinaries(targetVersion, onProgress)

    // Update container config if container name provided
    if (containerName && targetVersion !== fullVersion) {
      await containerManager.updateConfig(containerName, {
        version: targetVersion,
      })
    }

    return {
      binPath,
      actualVersion: targetVersion,
      wasHealed: targetVersion !== fullVersion,
    }
  }

  getBinaryUrl(version: string, plat: Platform, arc: Arch): string {
    return getBinaryUrl(version, plat, arc)
  }

  async verifyBinary(binPath: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    // Extract version from path like "postgresql-17.7.0-darwin-arm64"
    const match = binPath.match(/postgresql-(\d+(?:\.\d+)*)/)
    if (!match) {
      throw new Error(
        `Could not extract PostgreSQL version from path: ${binPath}`,
      )
    }
    const version = match[1]
    return postgresqlBinaryManager.verify(version, p, a)
  }

  // Downloads binaries and registers all tools (server and client) in config.
  // hostdb bundles all PostgreSQL binaries for all platforms.
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    const binPath = await postgresqlBinaryManager.ensureInstalled(
      version,
      p,
      a,
      onProgress,
    )

    // Register all binaries from downloaded package in config
    const ext = platformService.getExecutableExtension()

    // All PostgreSQL tools bundled in hostdb downloads
    const allTools = [
      // Server binaries
      'postgres',
      'pg_ctl',
      'initdb',
      // Client tools
      'psql',
      'pg_dump',
      'pg_restore',
      'pg_basebackup',
    ] as const

    for (const tool of allTools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform: p, arch: a } = this.getPlatformInfo()
    return postgresqlBinaryManager.isInstalled(version, p, a)
  }

  /**
   * Check if any compatible binaries are installed for the given version.
   * Returns true if either the exact version OR any same-major-version binaries exist.
   * This is used by the CLI to determine if it needs to prompt for download.
   */
  hasCompatibleBinaries(version: string): boolean {
    const fullVersion = this.resolveFullVersion(version)
    const { platform: p, arch: a } = this.getPlatformInfo()

    // Check if exact version exists
    const expectedPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: p,
      arch: a,
    })

    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(expectedPath, 'bin', `pg_ctl${ext}`)

    if (existsSync(pgCtlPath)) {
      return true
    }

    // Check if any same-major version exists
    const majorVersion = fullVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'postgresql',
      majorVersion,
      p,
      a,
    )

    return installed !== null
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

    // Check if already running (idempotent behavior)
    const alreadyRunning = await processManager.isRunning(name, {
      engine: this.name,
    })
    if (alreadyRunning) {
      return {
        port,
        connectionString: this.getConnectionString(container),
      }
    }

    // Get binary path with self-healing fallback
    const { binPath, wasHealed } = await this.getBinaryPathWithFallback(
      version,
      name,
      onProgress,
    )

    if (wasHealed) {
      onProgress?.({
        stage: 'info',
        message: 'Container version updated to match available binaries',
      })
    }

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

    // Get binary path with self-healing fallback (no progress callback for stop)
    const { binPath } = await this.getBinaryPathWithFallback(version, name)

    const ext = platformService.getExecutableExtension()
    const pgCtlPath = join(binPath, 'bin', `pg_ctl${ext}`)
    const dataDir = paths.getContainerDataPath(name, { engine: this.name })

    await processManager.stop(pgCtlPath, dataDir)
  }

  async status(container: ContainerConfig): Promise<StatusResult> {
    const { name, version } = container

    // Get binary path with self-healing fallback (no progress callback for status)
    const { binPath } = await this.getBinaryPathWithFallback(version, name)

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
      containerVersion: version, // Pass container version for version-matched binary lookup
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

  /**
   * Get a compatible pg_dump path for dumping from a remote database
   *
   * This checks the remote database version and finds a compatible pg_dump:
   * 1. First checks if the current pg_dump is compatible
   * 2. If not, tries to find a direct path to a compatible version
   * 3. If that fails, tries to switch Homebrew links
   * 4. If all else fails, throws an error with install instructions
   */
  async getCompatiblePgDumpPath(connectionString: string): Promise<{
    path: string
    switched: boolean
    warnings: string[]
  }> {
    const warnings: string[] = []

    // Get current pg_dump path with version validation
    const { path, versionMismatch, cachedVersion, actualVersion } =
      await configManager.getBinaryPathWithVersionCheck('pg_dump')

    if (!path) {
      throw new SpinDBError(
        ErrorCodes.DEPENDENCY_MISSING,
        'pg_dump not found. Install PostgreSQL client tools.',
        'fatal',
        'macOS: brew install postgresql@17 && brew link --overwrite postgresql@17\n' +
          'Ubuntu/Debian: apt install postgresql-client',
      )
    }

    if (versionMismatch) {
      warnings.push(
        `pg_dump version changed: ${cachedVersion} -> ${actualVersion} (Homebrew link changed)`,
      )
    }

    // Check compatibility with remote database
    let compatibility: DumpCompatibilityResult
    try {
      compatibility = await validateDumpCompatibility({
        connectionString,
        pgDumpPath: path,
      })
    } catch (error) {
      // Connection or version detection failed
      const e = error as Error
      throw new SpinDBError(
        ErrorCodes.CONNECTION_FAILED,
        `Failed to detect remote database version: ${e.message}`,
        'fatal',
        'Check your connection string and ensure the database is accessible.',
      )
    }

    if (compatibility.compatible) {
      return { path, switched: false, warnings }
    }

    // Handle incompatibility based on required action
    // All cases that don't return will fall through to VERSION_MISMATCH error below
    switch (compatibility.requiredAction) {
      case 'use_direct_path':
        if (compatibility.alternativePath) {
          warnings.push(
            `Using PostgreSQL ${compatibility.switchTarget} pg_dump (remote DB is v${compatibility.remoteDbVersion.majorVersion})`,
          )
          return {
            path: compatibility.alternativePath,
            switched: false,
            warnings,
          }
        }
        // No alternative path available - fall through to VERSION_MISMATCH error
        break

      case 'switch_homebrew':
        if (compatibility.switchTarget) {
          const switchResult = await switchHomebrewVersion(
            compatibility.switchTarget,
          )
          if (switchResult.success) {
            // Refresh config cache after switching
            await configManager.refreshBinaryWithVersion('pg_dump')
            await configManager.refreshBinaryWithVersion('pg_restore')
            await configManager.refreshBinaryWithVersion('psql')

            const newPath = await configManager.getBinaryPath('pg_dump')
            if (newPath) {
              warnings.push(
                `Switched Homebrew from PostgreSQL ${switchResult.previousVersion} to ${switchResult.currentVersion}`,
              )
              return { path: newPath, switched: true, warnings }
            }
          }
        }
        // Switch failed or no target - fall through to VERSION_MISMATCH error
        break

      case 'install':
        // User needs to install manually - fall through to VERSION_MISMATCH error
        break
    }

    // Cannot auto-fix - throw error with install instructions
    throw new SpinDBError(
      ErrorCodes.VERSION_MISMATCH,
      compatibility.error ||
        `Your pg_dump version (${compatibility.localToolVersion.major}) cannot dump from PostgreSQL ${compatibility.remoteDbVersion.majorVersion}`,
      'fatal',
      `Install PostgreSQL ${compatibility.remoteDbVersion.majorVersion} client tools:\n` +
        `  brew install postgresql@${compatibility.remoteDbVersion.majorVersion}`,
      { compatibility },
    )
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

  /**
   * Dump a remote database to a file
   *
   * This method automatically detects the remote database version and uses
   * a compatible pg_dump binary. If the current pg_dump is incompatible,
   * it will try to find or switch to a compatible version.
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    // Get compatible pg_dump path (may switch versions or use direct path)
    const { path: pgDumpPath, warnings } =
      await this.getCompatiblePgDumpPath(connectionString)

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
            warnings,
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

  async terminateConnections(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    assertValidDatabaseName(database)
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    // Terminate all connections to the database except our own
    const sql = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`

    // Connect to 'postgres' database for admin operations
    // Escape single quotes for shell: ' becomes '\'' (end quote, escaped quote, start quote)
    const shellEscapedSql = sql.replace(/'/g, "'\\''")
    const cmd = isWindows()
      ? `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c "${sql.replace(/"/g, '\\"')}"`
      : `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c '${shellEscapedSql}'`

    try {
      await execAsync(cmd)
    } catch {
      // Ignore errors - connections may already be gone
    }
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
        const { stdout, stderr } = await execAsync(cmd)
        if (stdout) process.stdout.write(stdout)
        if (stderr) process.stderr.write(stderr)
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

  async executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const { port } = container
    const db = options?.database || container.database || 'postgres'
    const psqlPath = await this.getPsqlPath()

    // Use --csv for machine-readable output
    const args = [
      '-X', // Skip ~/.psqlrc to ensure deterministic CSV output
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      db,
      '--csv',
      '-c',
      query,
    ]

    return new Promise((resolve, reject) => {
      const proc = spawn(psqlPath, args, {
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
          resolve(parseCSVToQueryResult(stdout))
        } else {
          reject(new Error(stderr || `psql exited with code ${code}`))
        }
      })
    })
  }

  /**
   * List all user databases, excluding system databases (template0, template1, postgres).
   */
  async listDatabases(container: ContainerConfig): Promise<string[]> {
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    // Query pg_database for all non-system databases
    const sql = `SELECT datname FROM pg_database WHERE datname NOT IN ('template0', 'template1', 'postgres') AND datistemplate = false ORDER BY datname`

    const args = [
      '-X', // Skip ~/.psqlrc
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      'postgres',
      '-t', // Tuples only (no headers)
      '-A', // Unaligned output
      '-c',
      sql,
    ]

    return new Promise((resolve, reject) => {
      const proc = spawn(psqlPath, args, {
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
          const databases = stdout
            .trim()
            .split('\n')
            .map((db) => db.trim())
            .filter((db) => db.length > 0)
          resolve(databases)
        } else {
          reject(new Error(stderr || `psql exited with code ${code}`))
        }
      })
    })
  }

  async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    const { username, password, database } = options
    assertValidUsername(username)
    const { port } = container
    const db = database || container.database
    if (!db) {
      throw new Error(
        'No target database specified. Provide a database name with --database or ensure the container has a default database.',
      )
    }
    assertValidDatabaseName(db)
    const psqlPath = await this.getPsqlPath()

    // Pass SQL via stdin (psql -f -) to avoid exposing passwords in process listings
    const psqlBaseArgs = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      'postgres',
      '-f',
      '-',
    ]

    const runPsqlViaStdin = (sql: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const proc = spawn(psqlPath, psqlBaseArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          ...getWindowsSpawnOptions(),
        })

        let stderr = ''
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        proc.on('error', reject)

        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(stderr || `psql exited with code ${code}`))
        })

        proc.stdin?.write(sql)
        proc.stdin?.end()
      })

    // Create the role with login and password
    const createRoleSql = `CREATE ROLE "${username}" WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`

    try {
      await runPsqlViaStdin(createRoleSql)
    } catch (error) {
      const err = error as Error
      if (err.message.includes('already exists')) {
        // User exists — update password instead
        const alterSql = `ALTER ROLE "${username}" WITH PASSWORD '${password.replace(/'/g, "''")}'`
        await runPsqlViaStdin(alterSql)
      } else {
        throw error
      }
    }

    // Grant all privileges on the target database
    const grantSql = `GRANT ALL PRIVILEGES ON DATABASE "${db}" TO "${username}"`
    await runPsqlViaStdin(grantSql)

    const connectionString = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`

    return {
      username,
      password,
      connectionString,
      engine: container.engine,
      container: container.name,
      database: db,
    }
  }
}

export const postgresqlEngine = new PostgreSQLEngine()
