/**
 * InfluxDB restore module
 * Supports SQL-based restore using InfluxDB's REST API
 */

import { open, readFile as readFileAsync } from 'fs/promises'
import { existsSync, statSync } from 'fs'
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

    // Check for InfluxDB-specific marker first
    if (content.includes('-- InfluxDB SQL Backup')) {
      return {
        format: 'sql',
        description: 'InfluxDB SQL dump file (detected by content)',
        restoreCommand:
          'Restore via InfluxDB REST API (spindb restore handles this)',
      }
    }

    // Fall back to generic SQL markers with a warning
    if (content.includes('INSERT INTO') || content.includes('CREATE TABLE')) {
      logDebug(
        `Backup file "${filePath}" detected as SQL by generic markers (INSERT INTO / CREATE TABLE) — not the InfluxDB-specific header. Verify this is an InfluxDB backup.`,
      )
      return {
        format: 'sql',
        description:
          'SQL dump file (detected by generic markers, may not be InfluxDB-specific)',
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
 * Parse SQL VALUES clause into an array of string values.
 * Handles SQL string escaping ('' for embedded single quotes).
 *
 * NOTE: The `if (trimmed)` check on comma is intentional. Quoted strings push
 * their value when the closing quote is encountered, leaving `current` empty.
 * The subsequent comma separator sees that empty `current` and correctly skips
 * it — it's a delimiter between quoted values, not an empty field. The backup
 * code (backup.ts) never produces truly empty values (always NULL, numbers,
 * booleans, or quoted strings), so this is safe. Do NOT change to always-push
 * without also fixing the quoted-string-then-comma double-push problem.
 */
function parseSqlValues(valuesStr: string): string[] {
  const values: string[] = []
  let current = ''
  let inString = false

  for (let i = 0; i < valuesStr.length; i++) {
    const ch = valuesStr[i]

    if (inString) {
      if (ch === "'" && valuesStr[i + 1] === "'") {
        // Escaped single quote
        current += "'"
        i++
      } else if (ch === "'") {
        // End of string
        inString = false
        values.push(current)
        current = ''
      } else {
        current += ch
      }
    } else {
      if (ch === "'") {
        inString = true
        current = ''
      } else if (ch === ',') {
        const trimmed = current.trim()
        if (trimmed) {
          values.push(trimmed)
        }
        current = ''
      } else {
        current += ch
      }
    }
  }

  const trimmed = current.trim()
  if (trimmed) {
    values.push(trimmed)
  }

  return values
}

/**
 * Convert parsed INSERT data to InfluxDB line protocol format.
 * Format: measurement,tag1=val1 field1="val1",field2="val2" timestamp_ns
 *
 * Tag columns (from backup metadata) become line protocol tags,
 * remaining columns become fields. This preserves the original schema
 * so that records with the same timestamp remain distinct.
 */
/**
 * Encode a SQL value as an InfluxDB line protocol field value.
 * - Booleans: unquoted (true/false)
 * - Integers: trailing 'i' (e.g. 123i) — only when the raw string has no
 *   decimal point or exponent, so "123.0" is preserved as a float
 * - Floats: unquoted numeric (e.g. 3.14)
 * - Strings: double-quoted with escaping
 */
export function encodeFieldValue(val: string): string {
  if (val === 'true' || val === 'false') {
    return val
  }

  const num = Number(val)
  if (!isNaN(num) && val !== '') {
    if (Number.isInteger(num) && !/[.eE]/.test(val)) {
      return `${num}i`
    }
    return `${num}`
  }

  const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

function toLineProtocol(
  table: string,
  columns: string[],
  values: string[],
  tagColumns: Set<string>,
): string | null {
  const tags: string[] = []
  const fields: string[] = []
  let timestampNs = ''

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]
    const val = values[i]

    if (!val || val === 'NULL') continue

    if (col === 'time') {
      const ms = new Date(val).getTime()
      if (!isNaN(ms)) {
        timestampNs = String(ms * 1_000_000)
      } else {
        logDebug(`Warning: unparseable timestamp value "${val}" in restore`)
      }
      continue
    }

    if (tagColumns.has(col)) {
      // Tags: key=value (no quotes, escape spaces/commas/equals)
      const escaped = val
        .replace(/\\/g, '\\\\')
        .replace(/ /g, '\\ ')
        .replace(/,/g, '\\,')
        .replace(/=/g, '\\=')
      tags.push(`${col}=${escaped}`)
    } else {
      fields.push(`${col}=${encodeFieldValue(val)}`)
    }
  }

  if (fields.length === 0) return null

  let line = table
  if (tags.length > 0) {
    line += `,${tags.join(',')}`
  }
  line += ` ${fields.join(',')}`
  if (timestampNs) {
    line += ` ${timestampNs}`
  }
  return line
}

/**
 * Restore from SQL backup by parsing INSERT statements, converting to
 * line protocol, and writing via the write_lp endpoint.
 *
 * InfluxDB 3.x does not support INSERT via the query_sql endpoint —
 * data writes must go through /api/v3/write_lp.
 */
async function restoreSqlBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database } = options

  logDebug(
    `Restoring SQL backup to InfluxDB on port ${port}, database ${database}`,
  )

  const content = await readFileAsync(backupPath, 'utf-8')

  // Parse tag metadata from backup comments (-- Tags: col1, col2)
  const tagsByTable = new Map<string, Set<string>>()
  const tagsRegex = /-- Table: (\S+)\r?\n-- Tags: (.+)/g
  let tagsMatch
  while ((tagsMatch = tagsRegex.exec(content)) !== null) {
    const table = tagsMatch[1]
    const tags = new Set(tagsMatch[2].split(',').map((t) => t.trim()))
    tagsByTable.set(table, tags)
  }

  // Parse INSERT INTO statements and convert to line protocol
  const insertRegex =
    /INSERT INTO "([^"]+)"\s*\(([^)]+)\)\s*VALUES\s*\((.+)\);/g
  const linesByTable = new Map<string, string[]>()

  let match
  while ((match = insertRegex.exec(content)) !== null) {
    const table = match[1]
    const columns = match[2].split(',').map((c) => c.trim().replace(/"/g, ''))
    const values = parseSqlValues(match[3])
    const tableTags = tagsByTable.get(table) ?? new Set<string>()
    const line = toLineProtocol(table, columns, values, tableTags)

    if (line) {
      if (!linesByTable.has(table)) linesByTable.set(table, [])
      linesByTable.get(table)!.push(line)
    }
  }

  logDebug(
    `Parsed ${[...linesByTable.values()].reduce((sum, l) => sum + l.length, 0)} records from ${linesByTable.size} tables`,
  )

  let totalRecords = 0
  const errors: string[] = []

  for (const [table, lines] of linesByTable) {
    const body = lines.join('\n')
    try {
      const response = await influxdbApiRequest(
        port,
        'POST',
        `/api/v3/write_lp?db=${encodeURIComponent(database)}`,
        body,
      )

      if (response.status < 300) {
        totalRecords += lines.length
      } else {
        errors.push(
          `Failed to write ${table}: ${JSON.stringify(response.data)}`,
        )
        logDebug(
          `write_lp error for ${table}: ${JSON.stringify(response.data)}`,
        )
      }
    } catch (error) {
      errors.push(
        `Error writing ${table}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const message =
    `Restored ${totalRecords} records from ${linesByTable.size} tables` +
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
