/**
 * CockroachDB backup module
 * Supports SQL-based backups using cockroach sql
 *
 * CockroachDB backup formats:
 * - SQL: DDL + INSERT statements (portable, human-readable)
 */

import { spawn } from 'child_process'
import { stat, mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  requireCockroachPath,
  validateCockroachIdentifier,
  escapeCockroachIdentifier,
} from './cli-utils'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Execute a CockroachDB query and return the result
 */
async function execCockroachQuery(
  cockroachPath: string,
  port: number,
  database: string,
  query: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      'sql',
      '--insecure',
      '--host',
      `127.0.0.1:${port}`,
      '--database',
      database,
      '--execute',
      query,
      '--format=csv',
    ]

    const proc = spawn(cockroachPath, args, {
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

    proc.on('error', reject)

    proc.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve(stdout)
      } else {
        reject(new Error(stderr || `cockroach sql exited with code ${code}`))
      }
    })
  })
}

/**
 * Get list of tables in a database
 */
async function getTables(
  cockroachPath: string,
  port: number,
  database: string,
): Promise<string[]> {
  // Validate database identifier to prevent SQL injection
  validateCockroachIdentifier(database, 'database')

  const result = await execCockroachQuery(
    cockroachPath,
    port,
    database,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  )

  // Parse CSV output (skip header row)
  const lines = result.trim().split('\n')
  if (lines.length <= 1) return []

  return lines
    .slice(1) // Skip header
    .map((line) => line.trim())
    .filter((t) => t)
}

/**
 * Get CREATE TABLE statement for a table
 */
async function getCreateTableStatement(
  cockroachPath: string,
  port: number,
  database: string,
  table: string,
): Promise<string> {
  // Validate identifiers to prevent SQL injection
  validateCockroachIdentifier(database, 'database')
  validateCockroachIdentifier(table, 'table')
  const escapedTable = escapeCockroachIdentifier(table)

  const result = await execCockroachQuery(
    cockroachPath,
    port,
    database,
    `SHOW CREATE TABLE ${escapedTable}`,
  )

  // Parse CSV output - format is: table_name,create_statement
  const lines = result.trim().split('\n')
  if (lines.length < 2) {
    throw new Error(`Could not get CREATE TABLE for ${table}`)
  }

  // The create statement may span multiple lines, so join everything after the header
  // and extract the statement part
  const dataLines = lines.slice(1).join('\n')

  // CockroachDB CSV output has the create statement in the second column
  // Format: "table_name","CREATE TABLE..."
  const match = dataLines.match(/^"?[^"]*"?,\s*"?(CREATE TABLE[\s\S]*)"?$/i)
  if (match) {
    // Remove surrounding quotes and unescape double quotes
    return match[1].replace(/^"|"$/g, '').replace(/""/g, '"')
  }

  // Fallback: return everything after the first comma
  const commaIdx = dataLines.indexOf(',')
  if (commaIdx !== -1) {
    return dataLines.slice(commaIdx + 1).trim().replace(/^"|"$/g, '')
  }

  return dataLines
}

/**
 * Get INSERT statements for a table's data
 */
async function getTableData(
  cockroachPath: string,
  port: number,
  database: string,
  table: string,
): Promise<string[]> {
  validateCockroachIdentifier(table, 'table')
  const escapedTable = escapeCockroachIdentifier(table)

  // Get column names
  const columnsResult = await execCockroachQuery(
    cockroachPath,
    port,
    database,
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table.replace(/'/g, "''")}' ORDER BY ordinal_position`,
  )

  const columns = columnsResult
    .trim()
    .split('\n')
    .slice(1) // Skip header
    .map((line) => line.trim())
    .filter((c) => c)

  if (columns.length === 0) {
    return []
  }

  // Get data
  const dataResult = await execCockroachQuery(
    cockroachPath,
    port,
    database,
    `SELECT * FROM ${escapedTable}`,
  )

  const lines = dataResult.trim().split('\n')
  if (lines.length <= 1) {
    return [] // No data rows
  }

  const inserts: string[] = []

  // Parse CSV data rows
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue

    // Simple CSV parsing (handles basic cases)
    const fields = parseCSVLine(line)
    if (fields.length !== columns.length) {
      logWarning(`Column count mismatch for table ${table}: expected ${columns.length}, got ${fields.length}`)
      continue
    }

    const escapedValues = fields.map((field) => {
      // Unquoted empty string or unquoted literal 'NULL' becomes SQL NULL
      if (!field.wasQuoted && (field.value === '' || field.value === 'NULL')) {
        return 'NULL'
      }
      // Quoted empty string stays as empty string, all other values get escaped
      return `'${field.value.replace(/'/g, "''")}'`
    })

    const columnList = columns.map((c) => escapeCockroachIdentifier(c)).join(', ')
    inserts.push(`INSERT INTO ${escapedTable} (${columnList}) VALUES (${escapedValues.join(', ')});`)
  }

  return inserts
}

/**
 * Parsed CSV field with value and whether it was quoted
 */
type CSVField = {
  value: string
  wasQuoted: boolean
}

/**
 * Parse a CSV line (basic implementation)
 * Returns both the value and whether the field was quoted,
 * which is important for distinguishing empty strings from NULL
 */
function parseCSVLine(line: string): CSVField[] {
  const fields: CSVField[] = []
  let current = ''
  let inQuotes = false
  let fieldWasQuoted = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"'
        i++
      } else {
        // Toggle quote state
        if (!inQuotes) {
          fieldWasQuoted = true
        }
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      fields.push({ value: current, wasQuoted: fieldWasQuoted })
      current = ''
      fieldWasQuoted = false
    } else {
      current += char
    }
  }

  fields.push({ value: current, wasQuoted: fieldWasQuoted })
  return fields
}

/**
 * Create a SQL backup (DDL + INSERT statements)
 */
async function createSqlBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const { port, version } = container

  const cockroachPath = await requireCockroachPath(version)

  const lines: string[] = []
  lines.push('-- CockroachDB backup generated by SpinDB')
  lines.push(`-- Date: ${new Date().toISOString()}`)
  lines.push(`-- Database: ${database}`)
  lines.push('')

  // Get list of tables
  const tables = await getTables(cockroachPath, port, database)
  logDebug(`Found ${tables.length} tables to backup`)

  for (const table of tables) {
    lines.push(`-- Table: ${table}`)
    lines.push('')

    // Get CREATE TABLE statement
    try {
      const createStmt = await getCreateTableStatement(
        cockroachPath,
        port,
        database,
        table,
      )
      lines.push(createStmt + ';')
      lines.push('')
    } catch (error) {
      logWarning(`Could not get CREATE TABLE for ${table}: ${error}`)
      continue
    }

    // Export data
    try {
      const inserts = await getTableData(cockroachPath, port, database, table)
      if (inserts.length > 0) {
        lines.push(...inserts)
        lines.push('')
      }
    } catch (error) {
      logWarning(`Could not export data for ${table}: ${error}`)
    }
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // Write to file
  const content = lines.join('\n')
  await writeFile(outputPath, content, 'utf-8')

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'sql',
    size: stats.size,
  }
}

/**
 * Create a backup
 *
 * @param container - Container configuration
 * @param outputPath - Path to write backup file
 * @param options - Backup options
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const database = options.database || container.database || 'defaultdb'

  return createSqlBackup(container, outputPath, database)
}

/**
 * Create a backup for cloning purposes
 * Uses SQL format for reliability
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createSqlBackup(container, outputPath, container.database || 'defaultdb')
}
