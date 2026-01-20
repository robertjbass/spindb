/**
 * ClickHouse restore module
 * Supports SQL-based restores using clickhouse client
 */

import { spawn } from 'child_process'
import { open } from 'fs/promises'
import { existsSync, statSync, createReadStream } from 'fs'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  requireClickHousePath,
  validateClickHouseIdentifier,
  escapeClickHouseIdentifier,
} from './cli-utils'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * SQL keywords that indicate a ClickHouse SQL backup
 */
const CLICKHOUSE_SQL_KEYWORDS = [
  'CREATE TABLE',
  'CREATE DATABASE',
  'INSERT INTO',
  'ALTER TABLE',
  'DROP TABLE',
  'SELECT',
  'ATTACH',
  'DETACH',
]

/**
 * Check if file content looks like ClickHouse SQL
 * Only reads first 8KB to avoid loading large files into memory
 */
async function looksLikeClickHouseSql(filePath: string): Promise<boolean> {
  try {
    // Read only first 8KB - enough for several lines of SQL statements
    // Using 8KB (vs 4KB for Redis/Valkey) since SQL statements can be longer
    const HEADER_SIZE = 8192
    const buffer = Buffer.alloc(HEADER_SIZE)

    const fd = await open(filePath, 'r')
    let bytesRead: number
    try {
      const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
      bytesRead = result.bytesRead
    } finally {
      await fd.close()
    }

    const content = buffer.toString('utf-8', 0, bytesRead)
    const lines = content.split(/\r?\n/)

    let sqlStatementsFound = 0
    const linesToCheck = 20
    let checkedLines = 0

    for (const line of lines) {
      // Stop after checking linesToCheck lines
      if (checkedLines >= linesToCheck) break

      const trimmed = line.trim().toUpperCase()

      // Skip empty lines and comments (don't count toward linesToCheck)
      if (!trimmed || trimmed.startsWith('--')) continue

      checkedLines++

      // Check for SQL keywords
      for (const keyword of CLICKHOUSE_SQL_KEYWORDS) {
        if (trimmed.startsWith(keyword)) {
          sqlStatementsFound++
          break
        }
      }

      // Early success if we found 2 or more SQL statements
      if (sqlStatementsFound >= 2) {
        return true
      }
    }

    return sqlStatementsFound > 0
  } catch {
    return false
  }
}

/**
 * Detect backup format from file
 * Supports:
 * - SQL: DDL + INSERT statements
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file not found: ${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: 'Directory found - ClickHouse restore expects a single file',
      restoreCommand:
        'ClickHouse requires a single .sql file for restore',
    }
  }

  // Check file extension first for .sql files
  if (filePath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'ClickHouse SQL backup',
      restoreCommand:
        'Execute SQL statements via clickhouse client (spindb restore handles this)',
    }
  }

  // Content-based detection
  if (await looksLikeClickHouseSql(filePath)) {
    return {
      format: 'sql',
      description: 'ClickHouse SQL backup (detected by content)',
      restoreCommand:
        'Execute SQL statements via clickhouse client (spindb restore handles this)',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use .sql file with ClickHouse SQL statements',
  }
}

// Restore options for ClickHouse
export type RestoreOptions = {
  containerName: string
  port: number
  database?: string
  version?: string
  // Drop existing tables before restore
  clean?: boolean
}

/**
 * Execute a ClickHouse query and return the result
 */
async function executeQuery(
  clickhousePath: string,
  port: number,
  database: string,
  query: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--database',
      database,
      '--query',
      query,
    ]

    const proc = spawn(clickhousePath, args, {
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
        resolve(stdout.trim())
      } else {
        reject(new Error(`Query failed: ${stderr || `exit code ${code}`}`))
      }
    })

    proc.on('error', reject)
  })
}

/**
 * Get list of tables in a database
 */
async function getTablesInDatabase(
  clickhousePath: string,
  port: number,
  database: string,
): Promise<string[]> {
  try {
    // Validate database name
    validateClickHouseIdentifier(database, 'database')
    const escapedDb = database.replace(/'/g, "''")

    const result = await executeQuery(
      clickhousePath,
      port,
      database,
      `SELECT name FROM system.tables WHERE database = '${escapedDb}'`,
    )

    if (!result) {
      return []
    }

    return result
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    logDebug(`Failed to get tables: ${error}`)
    return []
  }
}

/**
 * Drop all tables in a database (for clean restore)
 */
async function dropAllTables(
  clickhousePath: string,
  port: number,
  database: string,
): Promise<void> {
  const tables = await getTablesInDatabase(clickhousePath, port, database)

  if (tables.length === 0) {
    logDebug('No existing tables to drop')
    return
  }

  logDebug(`Dropping ${tables.length} existing table(s) in database "${database}"`)

  for (const table of tables) {
    try {
      // Validate table name
      validateClickHouseIdentifier(table, 'table')
      const escapedTable = escapeClickHouseIdentifier(table)

      await executeQuery(
        clickhousePath,
        port,
        database,
        `DROP TABLE IF EXISTS ${escapedTable}`,
      )
      logDebug(`Dropped table: ${table}`)
    } catch (error) {
      // Log warning but continue with other tables
      logWarning(`Failed to drop table "${table}": ${error}`)
    }
  }
}

/**
 * Restore from SQL backup
 * Streams SQL statements to clickhouse client
 */
async function restoreSqlBackup(
  backupPath: string,
  port: number,
  database: string,
  version?: string,
  clean: boolean = false,
): Promise<RestoreResult> {
  const clickhousePath = await requireClickHousePath(version)

  // If clean mode, drop existing tables first
  if (clean) {
    logDebug('Clean mode: dropping existing tables before restore')
    await dropAllTables(clickhousePath, port, database)
  }

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--database',
      database,
      '--multiquery',
    ]

    const proc = spawn(clickhousePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let streamError: Error | null = null

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      // If there was a stream error, report it (include stderr for context)
      if (streamError) {
        const errorParts = [streamError.message]
        if (stderr && stderr.trim()) {
          errorParts.push(`ClickHouse stderr: ${stderr.trim()}`)
        }
        reject(new Error(errorParts.join('. ')))
        return
      }

      if (code === 0) {
        resolve({
          format: 'sql',
          stdout: stdout || 'SQL statements executed successfully',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `clickhouse client exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`Failed to spawn clickhouse client: ${error.message}`))
    })

    // Stream backup file to clickhouse client stdin
    const fileStream = createReadStream(backupPath, { encoding: 'utf-8' })

    // Handle stdin errors (e.g., EPIPE when client exits early due to SQL error)
    proc.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // EPIPE means the client closed its stdin (likely exited due to error)
      // The actual error message will come from stderr in the 'close' handler
      if (error.code === 'EPIPE') {
        streamError = new Error(
          'ClickHouse client closed connection early (likely SQL syntax error)',
        )
      } else {
        streamError = new Error(`Failed to write to clickhouse client: ${error.message}`)
      }
      fileStream.destroy()
    })

    fileStream.on('error', (error) => {
      streamError = new Error(`Failed to read backup file: ${error.message}`)
      fileStream.destroy()
      proc.stdin.end()
    })

    fileStream.pipe(proc.stdin)
  })
}

/**
 * Restore from backup
 * Supports:
 * - SQL: Execute statements via clickhouse client (ClickHouse must be running)
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database = 'default', version, clean = false } = options

  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  if (format.format === 'sql') {
    return restoreSqlBackup(backupPath, port, database, version, clean)
  }

  throw new Error(
    `Invalid backup format: ${format.format}. Use .sql file with ClickHouse SQL statements.`,
  )
}

/**
 * Parse ClickHouse connection string
 * Format: clickhouse://[user:password@]host[:port][/database]
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  user?: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid ClickHouse connection string: expected a non-empty string',
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
      `Invalid ClickHouse connection string: "${sanitized}". ` +
        `Expected format: clickhouse://[user:password@]host[:port][/database]`,
      { cause: error },
    )
  }

  // Validate protocol
  if (url.protocol !== 'clickhouse:' && url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Invalid ClickHouse connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "clickhouse://", "http://", or "https://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  // Default port depends on protocol - 9000 for native, 8123 for HTTP
  const defaultPort = url.protocol === 'http:' || url.protocol === 'https:' ? 8123 : 9000
  const port = parseInt(url.port, 10) || defaultPort

  // Database is in pathname
  const database = url.pathname.replace(/^\//, '') || 'default'

  return {
    host,
    port,
    database,
    user: url.username || undefined,
    password: url.password || undefined,
  }
}
