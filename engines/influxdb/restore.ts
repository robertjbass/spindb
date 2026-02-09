/**
 * InfluxDB restore module
 * Supports SQL-based restore using InfluxDB's REST API
 */

import { open } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { readFile as readFileAsync } from 'fs/promises'
import { logDebug } from '../../core/error-handler'
import { influxdbApiRequest } from './api-client'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Detect backup format from file
 * InfluxDB uses SQL dump files
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
      description: 'Directory found - InfluxDB uses single SQL dump files',
      restoreCommand: 'InfluxDB requires a single .sql file for restore',
    }
  }

  // Check file extension for .sql files
  if (filePath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'InfluxDB SQL dump file',
      restoreCommand:
        'Restore via InfluxDB REST API (spindb restore handles this)',
    }
  }

  // Check file contents for SQL patterns
  try {
    const HEADER_SIZE = 4096
    const buffer = Buffer.alloc(HEADER_SIZE)
    const fd = await open(filePath, 'r')
    let bytesRead: number
    try {
      const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
      bytesRead = result.bytesRead
    } finally {
      await fd.close().catch(() => {})
    }

    const content = buffer.toString('utf-8', 0, bytesRead)

    // Check for SQL content markers
    if (
      content.includes('-- InfluxDB SQL Backup') ||
      content.includes('INSERT INTO') ||
      content.includes('CREATE TABLE')
    ) {
      return {
        format: 'sql',
        description: 'InfluxDB SQL dump file (detected by content)',
        restoreCommand:
          'Restore via InfluxDB REST API (spindb restore handles this)',
      }
    }
  } catch (error) {
    logDebug(`Error reading backup file header: ${error}`)
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use .sql file for restore',
  }
}

// Restore options for InfluxDB
export type RestoreOptions = {
  containerName: string
  port: number
  database: string
}

/**
 * Restore from SQL backup by executing SQL statements via REST API
 */
async function restoreSqlBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database } = options

  logDebug(
    `Restoring SQL backup to InfluxDB on port ${port}, database ${database}`,
  )

  // Read the SQL file and execute statements
  const content = await readFileAsync(backupPath, 'utf-8')

  // Parse SQL statements (skip comments and empty lines)
  const statements = content
    .split('\n')
    .filter((line) => !line.startsWith('--') && line.trim().length > 0)
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  logDebug(`Found ${statements.length} SQL statements to execute`)

  let executedCount = 0
  const errors: string[] = []

  for (const sql of statements) {
    try {
      const response = await influxdbApiRequest(
        port,
        'POST',
        '/api/v3/query_sql',
        {
          db: database,
          q: sql,
          format: 'json',
        },
      )

      if (response.status >= 400) {
        errors.push(`Statement failed: ${sql.substring(0, 100)}...`)
        logDebug(`SQL error: ${JSON.stringify(response.data)}`)
      } else {
        executedCount++
      }
    } catch (error) {
      errors.push(
        `Statement error: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const message =
    `Executed ${executedCount}/${statements.length} statements` +
    (errors.length > 0 ? `. ${errors.length} errors.` : '')

  return {
    format: 'sql',
    stdout: message,
    code: errors.length > 0 ? 1 : 0,
  }
}

/**
 * Restore from backup
 * Supports SQL format
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  if (format.format === 'sql') {
    return restoreSqlBackup(backupPath, options)
  }

  throw new Error(
    `Invalid backup format: ${format.format}. Use .sql file for restore.`,
  )
}

/**
 * Parse InfluxDB connection string
 * Format: http://host[:port], https://host[:port], or influxdb://host[:port]
 *
 * The influxdb:// scheme is an alias for http://
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'https'
  database?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid InfluxDB connection string: expected a non-empty string',
    )
  }

  // Handle influxdb:// scheme
  let normalized = connectionString.trim()
  if (normalized.startsWith('influxdb://')) {
    normalized = normalized.replace('influxdb://', 'http://')
  }

  let url: URL
  try {
    url = new URL(normalized)
  } catch (error) {
    throw new Error(
      `Invalid InfluxDB connection string: "${connectionString}". ` +
        `Expected format: http://host[:port] or influxdb://host[:port]`,
      { cause: error },
    )
  }

  // Validate protocol
  let protocol: 'http' | 'https'
  if (url.protocol === 'http:') {
    protocol = 'http'
  } else if (url.protocol === 'https:') {
    protocol = 'https'
  } else {
    throw new Error(
      `Invalid InfluxDB connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "http://", "https://", or "influxdb://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 8086
  const database = url.searchParams.get('db') || undefined

  return {
    host,
    port,
    protocol,
    database,
  }
}
