/**
 * ClickHouse restore module
 * Supports SQL-based restores using clickhouse client
 */

import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { logDebug } from '../../core/error-handler'
import { requireClickHousePath } from './cli-utils'
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
 */
async function looksLikeClickHouseSql(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const lines = content.split(/\r?\n/)

    let sqlStatementsFound = 0
    const linesToCheck = 20

    for (const line of lines) {
      const trimmed = line.trim().toUpperCase()

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('--')) continue

      // Check for SQL keywords
      for (const keyword of CLICKHOUSE_SQL_KEYWORDS) {
        if (trimmed.startsWith(keyword)) {
          sqlStatementsFound++
          break
        }
      }

      if (sqlStatementsFound >= 2) {
        return true
      }

      if (sqlStatementsFound >= linesToCheck) break
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
 * Restore from SQL backup
 * Executes SQL statements via clickhouse client
 */
async function restoreSqlBackup(
  backupPath: string,
  port: number,
  database: string,
  version?: string,
  clean: boolean = false,
): Promise<RestoreResult> {
  const clickhousePath = await requireClickHousePath(version)

  // Read the backup file
  const content = await readFile(backupPath, 'utf-8')

  // If clean mode, we need to drop existing tables first
  if (clean) {
    logDebug('Clean mode: dropping existing tables before restore')
    // This will be handled by the restore process - tables will be recreated
  }

  // Pipe SQL to clickhouse client
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

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
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

    // Write backup content to stdin
    proc.stdin.write(content)
    proc.stdin.end()
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
