/**
 * SQLite Engine
 *
 * SQLite is a file-based embedded database with no server process.
 * Key differences from PostgreSQL/MySQL:
 * - No start/stop operations (file-based)
 * - No port management
 * - Database files stored in user project directories (not ~/.spindb/)
 * - Uses a registry to track file paths
 */

import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, statSync, createReadStream, createWriteStream } from 'fs'
import { copyFile, unlink, mkdir, open, writeFile } from 'fs/promises'
import { resolve, dirname, join } from 'path'
import { tmpdir } from 'os'
import { BaseEngine } from '../base-engine'
import { sqliteRegistry } from './registry'
import { configManager } from '../../core/config-manager'
import { getEngineDefaults } from '../../config/engine-defaults'
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

const execFileAsync = promisify(execFile)
const engineDef = getEngineDefaults('sqlite')

export class SQLiteEngine extends BaseEngine {
  name = 'sqlite'
  displayName = 'SQLite'
  defaultPort = 0 // File-based, no port
  supportedVersions = engineDef.supportedVersions

  /**
   * SQLite uses system binaries - no download URL
   */
  getBinaryUrl(): string {
    throw new Error(
      'SQLite uses system-installed binaries. Install sqlite3:\n' +
        '  macOS: brew install sqlite (or use built-in /usr/bin/sqlite3)\n' +
        '  Ubuntu/Debian: sudo apt install sqlite3',
    )
  }

  /**
   * Verify sqlite3 binary exists
   */
  async verifyBinary(): Promise<boolean> {
    return this.isBinaryInstalled('3')
  }

  /**
   * Check if sqlite3 is installed on the system
   */
  async isBinaryInstalled(_version: string): Promise<boolean> {
    const sqlite3Path = await this.getSqlite3Path()
    return sqlite3Path !== null
  }

  /**
   * Ensure sqlite3 is available
   * SQLite uses system binaries, so this just verifies it exists
   */
  async ensureBinaries(
    _version: string,
    _onProgress?: ProgressCallback,
  ): Promise<string> {
    const sqlite3Path = await this.getSqlite3Path()
    if (!sqlite3Path) {
      throw new Error(
        'sqlite3 not found. Install SQLite:\n' +
          '  macOS: brew install sqlite (or use built-in /usr/bin/sqlite3)\n' +
          '  Ubuntu/Debian: sudo apt install sqlite3\n' +
          '  Fedora: sudo dnf install sqlite',
      )
    }
    return sqlite3Path
  }

  /**
   * Get path to sqlite3 binary
   * First checks config manager, then falls back to system PATH
   */
  async getSqlite3Path(): Promise<string | null> {
    // Check config manager first
    const configPath = await configManager.getBinaryPath('sqlite3')
    if (configPath) {
      return configPath
    }

    // Check system PATH
    try {
      const { stdout } = await execFileAsync('which', ['sqlite3'])
      const path = stdout.trim()
      return path || null
    } catch {
      return null
    }
  }

  /**
   * Get path to litecli (enhanced SQLite CLI)
   */
  async getLitecliPath(): Promise<string | null> {
    // Check config manager first
    const configPath = await configManager.getBinaryPath('litecli')
    if (configPath) {
      return configPath
    }

    // Check system PATH
    try {
      const { stdout } = await execFileAsync('which', ['litecli'])
      const path = stdout.trim()
      return path || null
    } catch {
      return null
    }
  }

  /**
   * Initialize a new SQLite database file
   * Creates an empty database at the specified path (or CWD)
   */
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
    const sqlite3 = await this.getSqlite3Path()
    if (!sqlite3) {
      throw new Error('sqlite3 not found')
    }

    await execFileAsync(sqlite3, [absolutePath, 'SELECT 1'])

    // Register in the SQLite registry
    await sqliteRegistry.add({
      name: containerName,
      filePath: absolutePath,
      created: new Date().toISOString(),
    })

    return absolutePath
  }

  /**
   * Start is a no-op for SQLite (file-based, no server)
   * Just verifies the file exists
   */
  async start(
    container: ContainerConfig,
    _onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      throw new Error(`SQLite container "${container.name}" not found in registry`)
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`SQLite database file not found: ${entry.filePath}`)
    }

    return {
      port: 0,
      connectionString: this.getConnectionString(container),
    }
  }

  /**
   * Stop is a no-op for SQLite (file-based, no server)
   */
  async stop(_container: ContainerConfig): Promise<void> {
    // No-op: SQLite is file-based, no server to stop
  }

  /**
   * Get status - check if the file exists
   */
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

  /**
   * Get connection string for SQLite
   * Returns sqlite:// URL format
   */
  getConnectionString(container: ContainerConfig, _database?: string): string {
    // container.database stores the file path for SQLite
    const filePath = container.database
    return `sqlite:///${filePath}`
  }

  /**
   * Open interactive SQLite shell
   * Prefers litecli if available, falls back to sqlite3
   */
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry) {
      throw new Error(`SQLite container "${container.name}" not found in registry`)
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`SQLite database file not found: ${entry.filePath}`)
    }

    // Try litecli first, fall back to sqlite3
    const litecli = await this.getLitecliPath()
    const sqlite3 = await this.getSqlite3Path()

    const cmd = litecli || sqlite3
    if (!cmd) {
      throw new Error(
        'sqlite3 not found. Install SQLite:\n' +
          '  macOS: brew install sqlite\n' +
          '  Ubuntu/Debian: sudo apt install sqlite3',
      )
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, [entry.filePath], { stdio: 'inherit' })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', () => resolve())
    })
  }

  /**
   * Create database is a no-op for SQLite
   * In SQLite, the file IS the database
   */
  async createDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    // No-op: SQLite file IS the database
    // If you need multiple "databases", create multiple containers
  }

  /**
   * Drop database - deletes the file and removes from registry
   */
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

  /**
   * Get database size by checking file size
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      return null
    }
    const stats = statSync(entry.filePath)
    return stats.size
  }

  /**
   * Detect backup format
   * SQLite backups are either .sql (dump) or .sqlite/.db (file copy)
   */
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

  /**
   * Create a backup of the SQLite database
   */
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
      const sqlite3 = await this.getSqlite3Path()
      if (!sqlite3) {
        throw new Error('sqlite3 not found')
      }

      // Pipe .dump output to file (avoids shell injection)
      await this.dumpToFile(sqlite3, entry.filePath, outputPath)
    } else {
      // Binary copy for 'dump' format
      await copyFile(entry.filePath, outputPath)
    }

    const stats = statSync(outputPath)
    return {
      path: outputPath,
      format: options.format,
      size: stats.size,
    }
  }

  /**
   * Restore a backup to the SQLite database
   */
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
      const sqlite3 = await this.getSqlite3Path()
      if (!sqlite3) {
        throw new Error('sqlite3 not found')
      }

      // Pipe file to sqlite3 stdin (avoids shell injection)
      await this.runSqlFile(sqlite3, entry.filePath, backupPath)
      return { format: 'sql' }
    } else {
      // Binary file copy
      await copyFile(backupPath, entry.filePath)
      return { format: 'sqlite' }
    }
  }

  /**
   * Create a dump from a SQLite file (for clone operations)
   * Supports:
   * - Local file paths: ./mydb.sqlite, /path/to/db.sqlite
   * - Local sqlite:// URLs: sqlite:///path/to/db.sqlite
   * - Remote HTTP/HTTPS: https://example.com/backup.sqlite
   */
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

    const sqlite3 = await this.getSqlite3Path()
    if (!sqlite3) {
      throw new Error('sqlite3 not found')
    }

    // Pipe .dump output to file (avoids shell injection)
    await this.dumpToFile(sqlite3, filePath, outputPath)

    // Clean up temp file if we downloaded it
    if (tempFile && existsSync(tempFile)) {
      await unlink(tempFile)
    }

    return { filePath: outputPath }
  }

  /**
   * Dump SQLite database to a file using spawn (avoids shell injection)
   * Equivalent to: sqlite3 dbPath .dump > outputPath
   */
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

  /**
   * Run a SQL file against SQLite database using spawn (avoids shell injection)
   * Equivalent to: sqlite3 dbPath < sqlFilePath
   */
  private async runSqlFile(
    sqlite3Path: string,
    dbPath: string,
    sqlFilePath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const input = createReadStream(sqlFilePath)
      const proc = spawn(sqlite3Path, [dbPath])

      input.pipe(proc.stdin)

      proc.stderr.on('data', (data: Buffer) => {
        // Collect stderr but don't fail immediately - sqlite3 may write warnings
        console.error(data.toString())
      })

      input.on('error', (err) => {
        proc.kill()
        reject(err)
      })

      proc.on('error', (err) => {
        reject(err)
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`sqlite3 script execution failed with exit code ${code}`))
        }
      })
    })
  }

  /**
   * Download a file from HTTP/HTTPS URL
   */
  private async downloadFile(url: string, destPath: string): Promise<void> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status} ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    await writeFile(destPath, Buffer.from(buffer))
  }

  /**
   * Validate a file is a valid SQLite database
   * SQLite files start with "SQLite format 3\0" (first 16 bytes)
   */
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

  /**
   * Run a SQL file or inline SQL statement
   */
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const entry = await sqliteRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('SQLite database file not found')
    }

    const sqlite3 = await this.getSqlite3Path()
    if (!sqlite3) {
      throw new Error('sqlite3 not found')
    }

    if (options.file) {
      // Run SQL file - pipe file to stdin (avoids shell injection)
      await this.runSqlFile(sqlite3, entry.filePath, options.file)
    } else if (options.sql) {
      // Run inline SQL - pass as argument (avoids shell injection)
      await execFileAsync(sqlite3, [entry.filePath, options.sql])
    } else {
      throw new Error('Either file or sql option must be provided')
    }
  }

  /**
   * Get available versions - SQLite uses system version
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    // SQLite uses system version, just return supported versions
    return { '3': ['3'] }
  }
}

export const sqliteEngine = new SQLiteEngine()
