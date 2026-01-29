/**
 * CockroachDB restore module
 * Supports SQL-based restores using cockroach sql
 */

import { spawn } from 'child_process'
import { open } from 'fs/promises'
import { existsSync, statSync, createReadStream } from 'fs'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  requireCockroachPath,
  validateCockroachIdentifier,
  escapeCockroachIdentifier,
} from './cli-utils'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * SQL keywords that indicate a CockroachDB/PostgreSQL SQL backup
 */
const COCKROACHDB_SQL_KEYWORDS = [
  'CREATE TABLE',
  'CREATE DATABASE',
  'CREATE INDEX',
  'CREATE SEQUENCE',
  'INSERT INTO',
  'ALTER TABLE',
  'DROP TABLE',
  'SELECT',
  'SET',
  'BEGIN',
  'COMMIT',
]

/**
 * Check if file content looks like CockroachDB/PostgreSQL SQL
 * Only reads first 8KB to avoid loading large files into memory
 */
async function looksLikeCockroachSql(filePath: string): Promise<boolean> {
  try {
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
      if (checkedLines >= linesToCheck) break

      const trimmed = line.trim().toUpperCase()

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('--')) continue

      checkedLines++

      // Check for SQL keywords
      for (const keyword of COCKROACHDB_SQL_KEYWORDS) {
        if (trimmed.startsWith(keyword)) {
          sqlStatementsFound++
          break
        }
      }

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
      description:
        'Directory found - CockroachDB restore expects a single file',
      restoreCommand: 'CockroachDB requires a single .sql file for restore',
    }
  }

  // Check file extension first for .sql files
  if (filePath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'CockroachDB SQL backup',
      restoreCommand:
        'Execute SQL statements via cockroach sql (spindb restore handles this)',
    }
  }

  // Content-based detection
  if (await looksLikeCockroachSql(filePath)) {
    return {
      format: 'sql',
      description: 'CockroachDB SQL backup (detected by content)',
      restoreCommand:
        'Execute SQL statements via cockroach sql (spindb restore handles this)',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use .sql file with CockroachDB/PostgreSQL SQL statements',
  }
}

// Restore options for CockroachDB
export type RestoreOptions = {
  containerName: string
  port: number
  database?: string
  version?: string
  // Drop existing tables before restore
  clean?: boolean
}

/**
 * Execute a CockroachDB query and return the result
 */
async function executeQuery(
  cockroachPath: string,
  port: number,
  database: string,
  query: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = [
      'sql',
      '--insecure',
      '--host',
      `127.0.0.1:${port}`,
      '--database',
      database,
      '--execute',
      query,
    ]

    const proc = spawn(cockroachPath, args, {
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
  cockroachPath: string,
  port: number,
  database: string,
): Promise<string[]> {
  try {
    validateCockroachIdentifier(database, 'database')

    const result = await executeQuery(
      cockroachPath,
      port,
      database,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )

    if (!result) {
      return []
    }

    // Parse output - skip header lines
    return result
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line && !line.startsWith('table_name') && !line.startsWith('-'),
      )
  } catch (error) {
    logDebug(`Failed to get tables: ${error}`)
    return []
  }
}

/**
 * Drop all tables in a database (for clean restore)
 */
async function dropAllTables(
  cockroachPath: string,
  port: number,
  database: string,
): Promise<void> {
  const tables = await getTablesInDatabase(cockroachPath, port, database)

  if (tables.length === 0) {
    logDebug('No existing tables to drop')
    return
  }

  logDebug(
    `Dropping ${tables.length} existing table(s) in database "${database}"`,
  )

  for (const table of tables) {
    try {
      validateCockroachIdentifier(table, 'table')
      const escapedTable = escapeCockroachIdentifier(table)

      await executeQuery(
        cockroachPath,
        port,
        database,
        `DROP TABLE IF EXISTS ${escapedTable} CASCADE`,
      )
      logDebug(`Dropped table: ${table}`)
    } catch (error) {
      logWarning(`Failed to drop table "${table}": ${error}`)
    }
  }
}

/**
 * Restore from SQL backup
 * Streams SQL statements to cockroach sql
 */
async function restoreSqlBackup(
  backupPath: string,
  port: number,
  database: string,
  version?: string,
  clean: boolean = false,
): Promise<RestoreResult> {
  const cockroachPath = await requireCockroachPath(version)

  // If clean mode, drop existing tables first
  if (clean) {
    logDebug('Clean mode: dropping existing tables before restore')
    await dropAllTables(cockroachPath, port, database)
  }

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = [
      'sql',
      '--insecure',
      '--host',
      `127.0.0.1:${port}`,
      '--database',
      database,
    ]

    const proc = spawn(cockroachPath, args, {
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
      if (streamError) {
        const errorParts = [streamError.message]
        if (stderr && stderr.trim()) {
          errorParts.push(`CockroachDB stderr: ${stderr.trim()}`)
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
            `cockroach sql exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`Failed to spawn cockroach sql: ${error.message}`))
    })

    // Stream backup file to cockroach sql stdin
    const fileStream = createReadStream(backupPath, { encoding: 'utf-8' })

    proc.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') {
        streamError = new Error(
          'CockroachDB closed connection early (likely SQL syntax error)',
        )
      } else {
        streamError = new Error(
          `Failed to write to cockroach sql: ${error.message}`,
        )
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
 * - SQL: Execute statements via cockroach sql (CockroachDB must be running)
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database = 'defaultdb', version, clean = false } = options

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
    `Invalid backup format: ${format.format}. Use .sql file with CockroachDB/PostgreSQL SQL statements.`,
  )
}

/**
 * Parse CockroachDB connection string
 * Format: postgresql://[user:password@]host[:port][/database]
 *
 * CockroachDB uses PostgreSQL wire protocol, so connection strings
 * use the postgresql:// scheme.
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
      'Invalid CockroachDB connection string: expected a non-empty string',
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
      `Invalid CockroachDB connection string: "${sanitized}". ` +
        `Expected format: postgresql://[user:password@]host[:port][/database]`,
      { cause: error },
    )
  }

  // Validate protocol - CockroachDB uses PostgreSQL protocol
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(
      `Invalid CockroachDB connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "postgresql://" or "postgres://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 26257

  // Database is in pathname
  const database = url.pathname.replace(/^\//, '') || 'defaultdb'

  return {
    host,
    port,
    database,
    user: url.username || undefined,
    password: url.password || undefined,
  }
}
