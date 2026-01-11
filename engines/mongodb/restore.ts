/**
 * MongoDB restore module
 * Wraps mongorestore for restoring database backups
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { logDebug, logWarning } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Get mongorestore path from config or system PATH
 */
async function getMongorestorePath(): Promise<string | null> {
  const { configManager } = await import('../../core/config-manager')
  const cachedPath = await configManager.getBinaryPath('mongorestore')
  if (cachedPath && existsSync(cachedPath)) return cachedPath

  const { platformService } = await import('../../core/platform-service')
  return platformService.findToolPath('mongorestore')
}

/**
 * Detect the format of a MongoDB backup
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file not found: ${filePath}`)
  }

  const stats = statSync(filePath)

  // Directory dump
  if (stats.isDirectory()) {
    return {
      format: 'directory',
      description: 'MongoDB directory dump (BSON files)',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE ${filePath}`,
    }
  }

  // Check file contents for archive format
  try {
    const buffer = Buffer.alloc(16)
    const fd = await import('fs').then((fs) => fs.promises.open(filePath, 'r'))
    let header: string
    try {
      await fd.read(buffer, 0, 16, 0)
      header = buffer.toString('utf8', 0, 6)
    } finally {
      await fd.close().catch(() => {})
    }

    // Check for gzip magic number
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      return {
        format: 'archive-gzip',
        description: 'MongoDB archive (gzip compressed)',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath} --gzip`,
      }
    }

    // Check for uncompressed archive (starts with "mtools")
    if (header === 'mtools' || header.includes('mongo')) {
      return {
        format: 'archive',
        description: 'MongoDB archive (uncompressed)',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath}`,
      }
    }

    // Check for BSON file
    if (filePath.endsWith('.bson')) {
      return {
        format: 'bson',
        description: 'MongoDB BSON file',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE ${filePath}`,
      }
    }

    // Default to archive format
    return {
      format: 'unknown',
      description: 'Unknown format - attempting as archive',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath}`,
    }
  } catch {
    return {
      format: 'unknown',
      description: 'Could not detect format',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT ${filePath}`,
    }
  }
}

/**
 * Restore options
 */
export type RestoreOptions = {
  port: number
  database: string
  drop?: boolean // Drop existing data before restore
  validateVersion?: boolean
}

/**
 * Restore a MongoDB backup using mongorestore
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database, drop = true } = options

  const mongorestore = await getMongorestorePath()
  if (!mongorestore) {
    throw new Error(
      'mongorestore not found. Download MongoDB binaries:\n' +
        '  Run: spindb engines download mongodb <version>\n' +
        '  Or download from: https://www.mongodb.com/try/download/database-tools',
    )
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  const args: string[] = [
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--db',
    database,
  ]

  if (drop) {
    args.push('--drop')
  }

  // Handle different formats
  if (format.format === 'directory') {
    // Directory dump - look for database subdirectory
    // First try the target database name
    const targetDbDir = join(backupPath, database)
    if (existsSync(targetDbDir)) {
      args.push(targetDbDir)
    } else {
      // For restores to a different database, find any database subdirectory
      // (mongodump creates backupPath/{sourceDatabase}/)
      const { readdirSync } = await import('fs')
      const entries = readdirSync(backupPath, { withFileTypes: true })
      const dbDirs = entries.filter((e) => e.isDirectory())

      if (dbDirs.length === 1) {
        // Single database directory - use it
        const sourceDbDir = join(backupPath, dbDirs[0].name)
        logDebug(`Using source database directory: ${sourceDbDir}`)
        args.push(sourceDbDir)
      } else if (dbDirs.length > 1) {
        // Multiple directories - try to find one with BSON files
        const dbWithBson = dbDirs.find((d) => {
          const dirPath = join(backupPath, d.name)
          const files = readdirSync(dirPath)
          return files.some((f) => f.endsWith('.bson'))
        })
        if (dbWithBson) {
          const sourceDbDir = join(backupPath, dbWithBson.name)
          logDebug(`Using source database directory with BSON files: ${sourceDbDir}`)
          args.push(sourceDbDir)
        } else {
          args.push(backupPath)
        }
      } else {
        // No subdirectories - use path directly
        args.push(backupPath)
      }
    }
  } else if (format.format === 'archive-gzip') {
    args.push('--archive=' + backupPath, '--gzip')
  } else if (format.format === 'archive') {
    args.push('--archive=' + backupPath)
  } else if (format.format === 'bson') {
    // BSON files are passed directly without --archive flag
    args.push(backupPath)
  } else {
    // Default to archive for unknown formats
    args.push('--archive=' + backupPath, '--gzip')
  }

  logDebug(`Running mongorestore with args: ${args.join(' ')}`)

  // Note: Don't use shell mode - spawn handles paths with spaces correctly
  // when shell: false (the default). Shell mode breaks paths like "C:\Program Files\..."
  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(mongorestore, args, spawnOptions)

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
          format: format.format,
          stdout,
          stderr,
          code,
        })
      } else {
        // mongorestore may exit with non-zero but still restore some data
        if (
          stderr.includes('continuing') ||
          stderr.includes('documents restored')
        ) {
          logWarning(`mongorestore completed with warnings: ${stderr}`)
          resolve({
            format: format.format,
            stdout,
            stderr,
            code: code ?? undefined,
          })
        } else {
          reject(new Error(stderr || `mongorestore exited with code ${code}`))
        }
      }
    })
  })
}

/**
 * Parsed MongoDB connection string result
 * For SRV URIs, only `uri` and `database` are set (host/port resolved via DNS)
 * For standard URIs, host/port are parsed directly
 */
export type ParsedConnectionString =
  | {
      isSrv: true
      uri: string
      database: string
    }
  | {
      isSrv: false
      host: string
      port: string
      database: string
      user?: string
      password?: string
    }

/**
 * Parse a MongoDB connection string
 *
 * Supported formats:
 * - mongodb://[user:password@]host[:port]/database
 * - mongodb+srv://[user:password@]host/database
 *
 * SRV URIs use DNS to resolve hosts/ports and must be passed as --uri to mongodump/mongorestore.
 *
 * Database name handling:
 * - Extracted from the URL pathname (e.g., "/mydb" → "mydb")
 * - Leading slash is stripped automatically
 * - If no database is specified (empty pathname or just "/"), defaults to "test"
 *   following MongoDB's convention for the default database name
 *
 * @param connectionString - MongoDB connection URI
 * @returns Parsed connection details with `isSrv` discriminator
 * @throws Error with descriptive message if:
 *   - Input is null, undefined, or not a string
 *   - URL is malformed (credentials are masked in error message)
 *   - Protocol is not "mongodb://" or "mongodb+srv://"
 */
export function parseConnectionString(
  connectionString: string,
): ParsedConnectionString {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid MongoDB connection string: expected a non-empty string',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    // Mask credentials in error message if present
    const sanitized = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//***:***@',
    )
    throw new Error(
      `Invalid MongoDB connection string: "${sanitized}". ` +
        `Expected format: mongodb://[user:password@]host[:port]/database`,
      { cause: error },
    )
  }

  // Validate protocol
  if (url.protocol !== 'mongodb:' && url.protocol !== 'mongodb+srv:') {
    throw new Error(
      `Invalid MongoDB connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "mongodb://" or "mongodb+srv://"`,
    )
  }

  const database = url.pathname.replace(/^\//, '') || 'test'

  // SRV URIs must be passed as-is via --uri (DNS resolves actual hosts/ports)
  if (url.protocol === 'mongodb+srv:') {
    return {
      isSrv: true,
      uri: connectionString,
      database,
    }
  }

  // Standard mongodb:// URIs can be parsed into host/port
  const host = url.hostname || '127.0.0.1'
  const port = url.port || '27017'
  const user = url.username || undefined
  const password = url.password || undefined

  return { isSrv: false, host, port, database, user, password }
}
