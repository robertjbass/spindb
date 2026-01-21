/**
 * DuckDB Engine
 *
 * DuckDB is a file-based embedded OLAP database with no server process.
 * Key differences from PostgreSQL/MySQL:
 * - No start/stop operations (file-based)
 * - No port management
 * - Database files stored in user project directories (not ~/.spindb/)
 * - Uses a registry to track file paths
 *
 * Binary sourcing:
 * - Downloads duckdb CLI from hostdb
 */

import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, statSync, createWriteStream, createReadStream } from 'fs'
import { copyFile, unlink, mkdir, open, writeFile } from 'fs/promises'
import { resolve, dirname, join } from 'path'
import { tmpdir } from 'os'
import { BaseEngine } from '../base-engine'
import { duckdbRegistry } from './registry'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { duckdbBinaryManager } from './binary-manager'
import { getBinaryUrl } from './binary-urls'
import {
  SUPPORTED_MAJOR_VERSIONS,
  DUCKDB_VERSION_MAP,
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

export class DuckDBEngine extends BaseEngine {
  name = 'duckdb'
  displayName = 'DuckDB'
  defaultPort = 0 // File-based, no port
  supportedVersions = SUPPORTED_MAJOR_VERSIONS

  // Get the download URL for DuckDB binaries from hostdb
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
    return getBinaryUrl(version, platform, arch)
  }

  async verifyBinary(): Promise<boolean> {
    return this.isBinaryInstalled('1')
  }

  async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = platformService.getPlatformInfo()
    return duckdbBinaryManager.isInstalled(version, platform, arch)
  }

  // Ensure DuckDB binaries are downloaded from hostdb and register tools
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = platformService.getPlatformInfo()

    // Download from hostdb
    const binPath = await duckdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )

    // Register all DuckDB tools in config
    const ext = platformService.getExecutableExtension()
    const tools = ['duckdb'] as const

    for (const tool of tools) {
      const toolPath = join(binPath, 'bin', `${tool}${ext}`)
      if (existsSync(toolPath)) {
        await configManager.setBinaryPath(tool, toolPath, 'bundled')
      }
    }

    return binPath
  }

  // Get path to duckdb binary - checks downloaded binary first
  override async getDuckDBPath(version?: string): Promise<string | null> {
    // Check config manager first (cached path from downloaded binaries)
    const configPath = await configManager.getBinaryPath('duckdb')
    if (configPath && existsSync(configPath)) {
      return configPath
    }

    // If version provided, check downloaded binary path directly
    if (version) {
      const { platform, arch } = platformService.getPlatformInfo()
      const fullVersion = normalizeVersion(version)
      const binPath = paths.getBinaryPath({
        engine: 'duckdb',
        version: fullVersion,
        platform,
        arch,
      })
      const ext = platformService.getExecutableExtension()
      const duckdbPath = join(binPath, 'bin', `duckdb${ext}`)
      if (existsSync(duckdbPath)) {
        return duckdbPath
      }
    }

    // Not found - require download
    return null
  }

  async initDataDir(
    containerName: string,
    _version: string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    // Determine file path - default to CWD
    const pathOption = options.path as string | undefined
    const filePath = pathOption || `./${containerName}.duckdb`
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
    if (await duckdbRegistry.isPathRegistered(absolutePath)) {
      throw new Error(`Path is already registered: ${absolutePath}`)
    }

    // Create empty database by running a simple query
    const duckdb = await this.requireDuckDBPath()

    await execFileAsync(duckdb, [absolutePath, '-c', 'SELECT 1'])

    // Register in the DuckDB registry
    await duckdbRegistry.add({
      name: containerName,
      filePath: absolutePath,
      created: new Date().toISOString(),
    })

    return absolutePath
  }

  // Start is a no-op for DuckDB (file-based, no server).
  async start(
    container: ContainerConfig,
    _onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry) {
      throw new Error(
        `DuckDB container "${container.name}" not found in registry`,
      )
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`DuckDB database file not found: ${entry.filePath}`)
    }

    return {
      port: 0,
      connectionString: this.getConnectionString(container),
    }
  }

  // Stop is a no-op for DuckDB (file-based, no server).
  async stop(_container: ContainerConfig): Promise<void> {}

  async status(container: ContainerConfig): Promise<StatusResult> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry) {
      return {
        running: false,
        message: 'Not registered in DuckDB registry',
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
    // container.database stores the file path for DuckDB
    const filePath = container.database
    return `duckdb:///${filePath}`
  }

  // Opens an interactive duckdb shell.
  async connect(container: ContainerConfig, _database?: string): Promise<void> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry) {
      throw new Error(
        `DuckDB container "${container.name}" not found in registry`,
      )
    }
    if (!existsSync(entry.filePath)) {
      throw new Error(`DuckDB database file not found: ${entry.filePath}`)
    }

    const cmd = await this.requireDuckDBPath()

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, [entry.filePath], { stdio: 'inherit' })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      proc.on('close', () => resolve())
    })
  }

  // In DuckDB, the file IS the database.
  async createDatabase(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {}

  async dropDatabase(
    container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    const entry = await duckdbRegistry.get(container.name)
    if (entry && existsSync(entry.filePath)) {
      await unlink(entry.filePath)
    }
    await duckdbRegistry.remove(container.name)
  }

  async getDatabaseSize(container: ContainerConfig): Promise<number | null> {
    const entry = await duckdbRegistry.get(container.name)
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
        description: 'DuckDB SQL dump',
        restoreCommand: 'duckdb <db> < <file>',
      }
    }
    return {
      format: 'duckdb',
      description: 'DuckDB database file (binary copy)',
      restoreCommand: 'cp <file> <db>',
    }
  }

  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('DuckDB database file not found')
    }

    if (options.format === 'sql') {
      // Use EXPORT DATABASE for SQL format
      const duckdb = await this.requireDuckDBPath()

      // DuckDB exports to a directory, so we need to handle this differently
      // For SQL format, we'll use a query to dump schema and data
      await this.dumpToFile(duckdb, entry.filePath, outputPath)
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
    const entry = await duckdbRegistry.get(container.name)
    if (!entry) {
      throw new Error(`Container "${container.name}" not registered`)
    }

    const format = await this.detectBackupFormat(backupPath)

    if (format.format === 'sql') {
      // Restore SQL dump
      const duckdb = await this.requireDuckDBPath()

      // Pipe file to duckdb stdin (avoids shell injection)
      await this.runSqlFile(duckdb, entry.filePath, backupPath)
      return { format: 'sql' }
    } else {
      // Binary file copy
      await copyFile(backupPath, entry.filePath)
      return { format: 'duckdb' }
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
      tempFile = join(tmpdir(), `spindb-download-${Date.now()}.duckdb`)
      await this.downloadFile(filePath, tempFile)

      // Validate it's a valid DuckDB database
      if (!(await this.isValidDuckDBFile(tempFile))) {
        await unlink(tempFile)
        throw new Error('Downloaded file is not a valid DuckDB database')
      }

      filePath = tempFile
    }
    // Handle duckdb:// URLs (strip prefix for local file)
    else if (filePath.startsWith('duckdb:///')) {
      filePath = filePath.slice('duckdb:///'.length)
    } else if (filePath.startsWith('duckdb://')) {
      filePath = filePath.slice('duckdb://'.length)
    }

    // Verify local file exists
    if (!existsSync(filePath)) {
      throw new Error(`DuckDB database file not found: ${filePath}`)
    }

    const duckdb = await this.requireDuckDBPath()

    try {
      // Dump to file (avoids shell injection)
      await this.dumpToFile(duckdb, filePath, outputPath)

      return { filePath: outputPath }
    } finally {
      // Clean up temp file if we downloaded it (even on error)
      if (tempFile && existsSync(tempFile)) {
        await unlink(tempFile)
      }
    }
  }

  /**
   * Dumps a DuckDB database to a SQL file.
   *
   * Uses a two-step approach:
   * 1. Get schema (CREATE TABLE statements)
   * 2. For each table, output INSERT statements
   *
   * Uses spawn to avoid shell injection.
   */
  private async dumpToFile(
    duckdbPath: string,
    dbPath: string,
    outputPath: string,
  ): Promise<void> {
    // Step 1: Get list of tables
    const tablesResult = await execFileAsync(duckdbPath, [
      dbPath,
      '-csv',
      '-noheader',
      '-c',
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'",
    ])
    const tables = tablesResult.stdout
      .trim()
      .split('\n')
      .filter((t) => t.length > 0)

    // Step 2: Build dump script - schema first, then data for each table
    const dumpCommands = [
      '.schema', // Output CREATE TABLE statements
    ]

    for (const table of tables) {
      // Quote table name and escape embedded double quotes
      const escapedTable = table.replace(/"/g, '""')
      // Set insert mode with table name for each table
      dumpCommands.push(`.mode insert ${escapedTable}`)
      dumpCommands.push(`SELECT * FROM "${escapedTable}";`)
    }

    const dumpScript = dumpCommands.join('\n')

    // Step 3: Execute dump script and write to file
    return new Promise((resolve, reject) => {
      const output = createWriteStream(outputPath)
      const proc = spawn(duckdbPath, [dbPath])
      let rejected = false

      const rejectOnce = (err: Error) => {
        if (!rejected) {
          rejected = true
          output.close()
          reject(err)
        }
      }

      // Pipe stdout to output file and handle errors
      proc.stdout.pipe(output)
      proc.stdout.on('error', (err) => {
        rejectOnce(new Error(`stdout error: ${err.message}`))
      })
      output.on('error', (err) => {
        rejectOnce(new Error(`output file error: ${err.message}`))
      })

      // Handle stdin errors (e.g., EPIPE if child exits early)
      proc.stdin.on('error', (err) => {
        rejectOnce(new Error(`stdin error: ${err.message}`))
      })

      proc.stderr.on('data', (data: Buffer) => {
        // Log stderr but don't fail (warnings are common)
        logDebug('duckdb dump stderr', { message: data.toString() })
      })

      proc.on('error', (err) => {
        rejectOnce(err)
      })

      proc.on('close', (code) => {
        output.close()
        if (!rejected) {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`duckdb dump failed with exit code ${code}`))
          }
        }
      })

      // Write the dump script to stdin with backpressure handling
      const writeOk = proc.stdin.write(dumpScript)
      if (writeOk) {
        proc.stdin.end()
      } else {
        // Handle backpressure: wait for drain before ending
        proc.stdin.once('drain', () => {
          proc.stdin.end()
        })
      }
    })
  }

  // Streams a SQL file to a DuckDB database via stdin
  private async runSqlFile(
    duckdbPath: string,
    dbPath: string,
    sqlFilePath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use 'ignore' for stdout since we don't need output and leaving it
      // unconsumed could fill the buffer and cause a deadlock
      const proc = spawn(duckdbPath, [dbPath], {
        stdio: ['pipe', 'ignore', 'pipe'],
      })

      let stderrData = ''
      let rejected = false

      const rejectOnce = (err: Error) => {
        if (!rejected) {
          rejected = true
          reject(err)
        }
      }

      // Handle stdin errors (e.g., EPIPE if child exits early)
      proc.stdin.on('error', (err) => {
        rejectOnce(new Error(`stdin error: ${err.message}`))
      })

      proc.stderr.on('data', (data: Buffer) => {
        stderrData += data.toString()
      })

      proc.on('error', (err) => {
        rejectOnce(err)
      })

      proc.on('close', (code) => {
        if (!rejected) {
          if (code === 0) {
            resolve()
          } else {
            reject(
              new Error(
                `duckdb failed with exit code ${code}${stderrData ? `: ${stderrData}` : ''}`,
              ),
            )
          }
        }
      })

      // Stream SQL file to duckdb stdin
      const fileStream = createReadStream(sqlFilePath, { encoding: 'utf-8' })

      fileStream.on('error', (error) => {
        rejectOnce(new Error(`Failed to read SQL file: ${error.message}`))
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

  /**
   * Validates that a file is a DuckDB database.
   *
   * DuckDB files have a specific binary header. We check:
   * 1. File is not empty and has minimum size (DuckDB files are at least 4KB)
   * 2. First bytes are not ASCII text (rules out SQL files)
   * 3. Try to execute a simple query to verify it's a valid database
   */
  private async isValidDuckDBFile(filePath: string): Promise<boolean> {
    try {
      // Check minimum file size (DuckDB databases are at least a few KB)
      const stats = statSync(filePath)
      if (stats.size < 4096) {
        return false
      }

      // Read first 16 bytes to check for text content
      const buffer = Buffer.alloc(16)
      const fd = await open(filePath, 'r')
      await fd.read(buffer, 0, 16, 0)
      await fd.close()

      // Check if file starts with common SQL text patterns (not a binary DuckDB file)
      const header = buffer.toString('utf8', 0, 16).toLowerCase()
      const textPatterns = ['create', 'insert', 'select', 'drop', '--', '/*', 'pragma']
      for (const pattern of textPatterns) {
        if (header.startsWith(pattern)) {
          return false // This is a SQL text file, not a DuckDB binary
        }
      }

      // Final validation: try to open with DuckDB and run a simple query
      const duckdb = await this.getDuckDBPath()
      if (duckdb) {
        try {
          await execFileAsync(duckdb, [filePath, '-c', 'SELECT 1'], {
            timeout: 5000,
          })
          return true
        } catch {
          return false
        }
      }

      // If we can't run DuckDB, fall back to binary header check
      // DuckDB files should have non-printable bytes in the header
      const hasNonPrintable = buffer.some(
        (b) => b !== 0 && (b < 32 || b > 126),
      )
      return hasNonPrintable
    } catch {
      return false
    }
  }

  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void> {
    const entry = await duckdbRegistry.get(container.name)
    if (!entry || !existsSync(entry.filePath)) {
      throw new Error('DuckDB database file not found')
    }

    const duckdb = await this.requireDuckDBPath()

    if (options.file) {
      // Run SQL file - pipe file to stdin (avoids shell injection)
      await this.runSqlFile(duckdb, entry.filePath, options.file)
    } else if (options.sql) {
      // Run inline SQL - pass as argument, output to stdout
      const { stdout, stderr } = await execFileAsync(duckdb, [
        entry.filePath,
        '-c',
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
      const duckdbReleases = getEngineReleases(releases, Engine.DuckDB)

      if (duckdbReleases && Object.keys(duckdbReleases).length > 0) {
        const result: Record<string, string[]> = {}

        for (const major of SUPPORTED_MAJOR_VERSIONS) {
          result[major] = []

          // Find all versions matching this major version
          for (const [, release] of Object.entries(duckdbReleases)) {
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
      logDebug('Failed to fetch DuckDB versions from hostdb, checking local', {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Offline fallback: return only locally installed versions
    const installed = await duckdbBinaryManager.listInstalled()
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
      const fullVersion = DUCKDB_VERSION_MAP[major]
      if (fullVersion) {
        result[major] = [fullVersion]
      }
    }
    return result
  }

  // Helper to get duckdb path or throw a helpful error
  private async requireDuckDBPath(): Promise<string> {
    const duckdb = await this.getDuckDBPath()
    if (!duckdb) {
      throw new Error(
        'duckdb not found. Ensure DuckDB binaries are downloaded:\n' +
          '  spindb engines download duckdb',
      )
    }
    return duckdb
  }
}

export const duckdbEngine = new DuckDBEngine()
