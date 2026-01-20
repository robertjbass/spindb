/**
 * SQLite Engine
 *
 * SQLite is a file-based embedded database with no server process.
 * Key differences from PostgreSQL/MySQL:
 * - No start/stop operations (file-based)
 * - No port management
 * - Database files stored in user project directories (not ~/.spindb/)
 * - Uses a registry to track file paths
 *
 * Binary sourcing:
 * - Downloads sqlite3 and related tools from hostdb
 * - Includes: sqlite3, sqldiff, sqlite3_analyzer, sqlite3_rsync
 */

import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, statSync, createWriteStream, createReadStream } from 'fs'
import { copyFile, unlink, mkdir, open, writeFile, readFile } from 'fs/promises'
import { resolve, dirname, join } from 'path'
import { tmpdir } from 'os'
import { BaseEngine } from '../base-engine'
import { sqliteRegistry } from './registry'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { sqliteBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  SUPPORTED_MAJOR_VERSIONS,
  SQLITE_VERSION_MAP,
  normalizeVersion,
} from './version-maps'
import {
  fetchHostdbReleases,
  getEngineReleases,
} from '../../core/hostdb-client'
import { logDebug } from '../../core/error-handler'
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
} from '../../types'

const execFileAsync = promisify(execFile)

export class SQLiteEngine extends BaseEngine {
  name = 'sqlite'
  displayName = 'SQLite'
  defaultPort = 0 // File-based, no port
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // Get the download URL for SQLite binaries from hostdb
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  async verifyBinary(): Promise<boolean> {
    return this.isBinaryInstalled('3')
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = platformService.getPlatformInfo()
    return sqliteBinaryManager.isInstalled(version, platform, arch)
  }

  // Ensure SQLite binaries are downloaded from hostdb and register tools
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = platformService.getPlatformInfo()

    // Download from hostdb
    const binPath = await sqliteBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register all SQLite tools in config
    const ext = platformService.getExecutableExtension()
    const tools = [
      'sqlite3',
      'sqldiff',
      'sqlite3_analyzer',
      'sqlite3_rsync',
    ] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  // Get path to sqlite3 binary - checks downloaded binary first
  override async getSqlite3Path(version?: string): Promise<string | null> {
    // Check config manager first (cached path from downloaded binaries)
    const configPath = await configManager.getBinaryPath('sqlite3')
    if (configPath && existsSync(configPath)) {
      return configPath
    }

    // If version provided, check downloaded binary path directly
    if (version) {
      const { platform, arch } = platformService.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'sqlite',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const sqlite3Path = join(binPath, 'bin', `sqlite3${ext}`)
      if (existsSync(sqlite3Path)) {
        return sqlite3Path
      }
    }

    // Not found - require download
    return null
  }

  async getLitecliPath(): Promise<string | null> {
    // Check config manager first
    const configPath = await configManager.getBinaryPath('litecli')
    if (configPath) {
      return configPath
    }

    // Check system PATH using platform service (works on Windows, macOS, Linux)
    return platformService.findToolPath('litecli')
  }

  async initDataDir(
    containerName: string,
    _version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    // Determine file path - default to CWD
    const pathOption = options.path as string | undefined
    const filePath = pathOption || `./${containerName}.sqlite`
    const absolutePath = resolve(filePath)

    // Ensure parent directory exists
    const dir = dirname(absolutePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    // Check if file already exists
    if (existsSync(absolutePath)) {
      throw new Error(`File already exists: ${absolutePath}`)
    }

    // Check if this path is already registered
    if (await sqliteRegistry.isPathRegistered(absolutePath)) {
      throw new Error(`Path is already registered: ${absolutePath}`)
    }

    // Create empty database by running a simple query
    const sqlite3 = await this.requireSqlite3Path()

    await execFileAsync(sqlite3, [absolutePath, 'SELECT 1'])

    // Register in the SQLite registry
    await sqliteRegistry.add({
      name: containerName,
      filePath: absolutePath,
      created: new Date().toISOString(),
    })

    return absolutePath
  }

  // Start is a no-op for SQLite (file-based, no server).
  async start(
    container: ContainerConfig,
    _onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      throw new Error(
        `SQLite container "${container.name}" not found in registry`,
      )
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`SQLite database file not found: ${entry.filePath}`)
    }

    return {
      port: 0,
      connectionString: this.getConnectionString(container),
    }
  }

  // Stop is a no-op for SQLite (file-based, no server).
  async stop(_container: ContainerConfig): Promise<void> {}

  async status(container: ContainerConfig): Promise<StatusResult> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      return {
        running: false,
        message: 'Not registered in SQLite registry',
      }
    }
    if (!existsSync(entry.filePath)) {
      return {
        running: false,
        message: `File not found: ${entry.filePath}`,
      }
    }
    return {
      running: true,
      message: 'Database file exists',
    }
  }

  getConnectionString(container: ContainerConfig, _database?: string): string {
    // container.database stores the file path for SQLite
    const filePath = container.database
    return `sqlite:///${filePath}`
  }

  // Prefers litecli if available, falls back to sqlite3.
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      throw new Error(
        `SQLite container "${container.name}" not found in registry`,
      )
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`SQLite database file not found: ${entry.filePath}`)
    }

    // Try litecli first, fall back to sqlite3
    const litecli = await this.getLitecliPath()
    const cmd = litecli ?? (await this.requireSqlite3Path())

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, [entry.filePath], { stdio: 'inherit' })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', () => resolve())
    })
  }

  // In SQLite, the file IS the database.
  async createDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {}

  async dropDatabase(
    container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    const entry = await sqliteRegistry.get(container.name)
    if (entry && existsSync(entry.filePath)) {
      await unlink(entry.filePath)
    }
    await sqliteRegistry.remove(container.name)
  }

  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      return null
    }
    const stats = statSync(entry.filePath)
    return stats.size
  }

  async detectBackupFormat(filePath: string): Promise<BackupFormat> {
    if (filePath.endsWith('.sql')) {
      return {
        format: 'sql',
        description: 'SQLite SQL dump',
        restoreCommand: 'sqlite3 <db> < <file>',
      }
    }
    return {
      format: 'sqlite',
      description: 'SQLite database file (binary copy)',
      restoreCommand: 'cp <file> <db>',
    }
  }

  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('SQLite database file not found')
    }

    if (options.format === 'sql') {
      // Use .dump command for SQL format
      const sqlite3 = await this.requireSqlite3Path()

      // Pipe .dump output to file (avoids shell injection)
      await this.dumpToFile(sqlite3, entry.filePath, outputPath)
    } else {
      // Binary copy for 'binary' format
      await copyFile(entry.filePath, outputPath)
    }

    const stats = statSync(outputPath)
    return {
      path: outputPath,
      format: options.format ?? 'binary',
      size: stats.size,
    }
  }

  async restore(
    container: ContainerConfig,
    backupPath: string,
    _options?: Record<string, unknown>,
  ): Promise<RestoreResult> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      throw new Error(`Container "${container.name}" not registered`)
    }

    const format = await this.detectBackupFormat(backupPath)

    if (format.format === 'sql') {
      // Restore SQL dump
      const sqlite3 = await this.requireSqlite3Path()

      // Pipe file to sqlite3 stdin (avoids shell injection)
      await this.runSqlFile(sqlite3, entry.filePath, backupPath)
      return { format: 'sql' }
    } else {
      // Binary file copy
      await copyFile(backupPath, entry.filePath)
      return { format: 'sqlite' }
    }
  }

  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult> {
    let filePath = connectionString
    let tempFile: string | null = null

    // Handle HTTP/HTTPS URLs - download to temp file
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      tempFile = join(tmpdir(), `spindb-download-${Date.now()}.sqlite`)
      await this.downloadFile(filePath, tempFile)

      // Validate it's a valid SQLite database
      if (!(await this.isValidSqliteFile(tempFile))) {
        await unlink(tempFile)
        throw new Error('Downloaded file is not a valid SQLite database')
      }

      filePath = tempFile
    }
    // Handle sqlite:// URLs (strip prefix for local file)
    else if (filePath.startsWith('sqlite:///')) {
      filePath = filePath.slice('sqlite:///'.length)
    } else if (filePath.startsWith('sqlite://')) {
      filePath = filePath.slice('sqlite://'.length)
    }

    // Verify local file exists
    if (!existsSync(filePath)) {
      throw new Error(`SQLite database file not found: ${filePath}`)
    }

    const sqlite3 = await this.requireSqlite3Path()

    try {
      // Pipe .dump output to file (avoids shell injection)
      await this.dumpToFile(sqlite3, filePath, outputPath)

      return { filePath: outputPath }
    } finally {
      // Clean up temp file if we downloaded it (even on error)
      if (tempFile && existsSync(tempFile)) {
        await unlink(tempFile)
      }
    }
  }

  // Uses spawn to avoid shell injection.
  private async dumpToFile(
    sqlite3Path: string,
    dbPath: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(outputPath)
      const proc = spawn(sqlite3Path, [dbPath, '.dump'])

      proc.stdout.pipe(output)

      proc.stderr.on('data', (data: Buffer) => {
        // Collect stderr but don't fail immediately - sqlite3 may write warnings
        console.error(data.toString())
      })

      proc.on('error', (err) => {
        output.close()
        reject(err)
      })

      proc.on('close', (code) => {
        output.close()
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`sqlite3 dump failed with exit code ${code}`))
        }
      })
    })
  }

  // Streams a SQL file to a SQLite database via stdin
  private async runSqlFile(
    sqlite3Path: string,
    dbPath: string,
    sqlFilePath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(sqlite3Path, [dbPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stderrData = ''
      let streamError: Error | null = null

      proc.stderr.on('data', (data: Buffer) => {
        stderrData += data.toString()
      })

      proc.on('error', (err) => {
        reject(err)
      })

      proc.on('close', (code) => {
        // If there was a stream error, report it
        if (streamError) {
          reject(streamError)
          return
        }

        if (code === 0) {
          resolve()
        } else {
          reject(
            new Error(
              `sqlite3 failed with exit code ${code}${stderrData ? `: ${stderrData}` : ''}`,
            ),
          )
        }
      })

      // Handle stdin errors (EPIPE if process exits early)
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') {
          reject(err)
        }
      })

      // Stream SQL file to sqlite3 stdin
      const fileStream = createReadStream(sqlFilePath, { encoding: 'utf-8' })

      fileStream.on('error', (error) => {
        streamError = new Error(`Failed to read SQL file: ${error.message}`)
        fileStream.destroy()
        proc.stdin.end()
      })

      fileStream.pipe(proc.stdin)
    })
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    const controller = new AbortController()
    const timeoutMs = 5 * 60 * 1000 // 5 minutes
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `File not found (404) at ${url}. ` +
              `This version may have been removed from hostdb. ` +
              `Try a different version or check https://github.com/robertjbass/hostdb/releases`,
          )
        }
        throw new Error(
          `Failed to download: ${response.status} ${response.statusText}`,
        )
      }

      const buffer = await response.arrayBuffer()
      await writeFile(destPath, Buffer.from(buffer))
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Download timed out after 5 minutes')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  // SQLite files start with "SQLite format 3\0" (first 16 bytes).
  private async isValidSqliteFile(filePath: string): Promise<boolean> {
    try {
      const buffer = Buffer.alloc(16)
      const fd = await open(filePath, 'r')
      await fd.read(buffer, 0, 16, 0)
      await fd.close()
      // Check for SQLite magic header
      return buffer.toString('utf8', 0, 15) === 'SQLite format 3'
    } catch {
      return false
    }
  }

  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('SQLite database file not found')
    }

    const sqlite3 = await this.requireSqlite3Path()

    if (options.file) {
      // Run SQL file - pipe file to stdin (avoids shell injection)
      await this.runSqlFile(sqlite3, entry.filePath, options.file)
    } else if (options.sql) {
      // Run inline SQL - pass as argument, output to stdout
      const { stdout, stderr } = await execFileAsync(sqlite3, [
        entry.filePath,
        options.sql,
      ])
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }

  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    // Try to fetch from hostdb first
    try {
      const releases = await fetchHostdbReleases()
      const sqliteReleases = getEngineReleases(releases, Engine.SQLite)

      if (sqliteReleases && Object.keys(sqliteReleases).length > 0) {
        const result: Record<string, string[]> = {}

        for (const major of SUPPORTED_MAJOR_VERSIONS) {
          result[major] = []

          // Find all versions matching this major version
          for (const [, release] of Object.entries(sqliteReleases)) {
            if (release.version.startsWith(`${major}.`)) {
              result[major].push(release.version)
            }
          }

          // Sort descending (latest first)
          result[major].sort((a, b) => {
            const partsA = a.split('.').map(Number)
            const partsB = b.split('.').map(Number)
            for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
              const diff = (partsB[i] || 0) - (partsA[i] || 0)
              if (diff !== 0) return diff
            }
            return 0
          })
        }

        return result
      }
    } catch (error) {
      logDebug('Failed to fetch SQLite versions from hostdb, checking local', {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Offline fallback: return only locally installed versions
    const installed = await sqliteBinaryManager.listInstalled()
    if (installed.length > 0) {
      const result: Record<string, string[]> = {}
      for (const binary of installed) {
        const major = binary.version.split('.')[0]
        if (!result[major]) {
          result[major] = []
        }
        if (!result[major].includes(binary.version)) {
          result[major].push(binary.version)
        }
      }
      return result
    }

    // Last resort: return hardcoded version map
    const result: Record<string, string[]> = {}
    for (const major of SUPPORTED_MAJOR_VERSIONS) {
      const fullVersion = SQLITE_VERSION_MAP[major]
      if (fullVersion) {
        result[major] = [fullVersion]
      }
    }
    return result
  }

  // Helper to get sqlite3 path or throw a helpful error
  private async requireSqlite3Path(): Promise<string> {
    const sqlite3 = await this.getSqlite3Path()
    if (!sqlite3) {
      throw new Error(
        'sqlite3 not found. Ensure SQLite binaries are downloaded:\n' +
          '  spindb engines download sqlite',
      )
    }
    return sqlite3
  }
}

export const sqliteEngine = new SQLiteEngine()
