/**
 * InfluxDB backup module
 * Supports SQL-based backup using InfluxDB's REST API to export data
 */

import { mkdir, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { influxdbApiRequest } from './api-client'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Create an SQL backup using InfluxDB's REST API
 * Queries all tables and exports data as SQL INSERT statements
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port } = container
  const database = options.database || container.database

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  logDebug(
    `Creating InfluxDB SQL backup via REST API on port ${port} for database "${database}"`,
  )

  // Get list of tables in the database
  const tablesResponse = await influxdbApiRequest(
    port,
    'POST',
    '/api/v3/query_sql',
    {
      db: database,
      q: 'SHOW TABLES',
      format: 'json',
    },
  )

  if (tablesResponse.status !== 200) {
    throw new Error(
      `Failed to list tables: ${JSON.stringify(tablesResponse.data)}`,
    )
  }

  const tablesData = tablesResponse.data as Array<Record<string, unknown>>
  const tables: string[] = []

  // Extract user table names: include rows with 'iox' schema or no schema field,
  // skip system schemas (information_schema, system, etc.)
  if (Array.isArray(tablesData)) {
    for (const row of tablesData) {
      const schema = row.table_schema as string | undefined
      if (schema && schema !== 'iox') continue
      const tableName =
        (row.table_name as string) ||
        (row.name as string) ||
        (Object.values(row)[0] as string)
      if (tableName) {
        tables.push(tableName)
      }
    }
  }

  logDebug(`Found ${tables.length} tables: ${tables.join(', ')}`)

  // Build SQL dump
  let sqlContent = `-- InfluxDB SQL Backup\n`
  sqlContent += `-- Database: ${database}\n`
  sqlContent += `-- Created: ${new Date().toISOString()}\n\n`

  for (const table of tables) {
    logDebug(`Exporting table: ${table}`)

    // Query column metadata to identify tag columns
    // Tags use Dictionary(Int32, Utf8) type in InfluxDB 3.x
    const tagColumns: string[] = []
    try {
      const colResponse = await influxdbApiRequest(
        port,
        'POST',
        '/api/v3/query_sql',
        {
          db: database,
          q: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table.replace(/'/g, "''")}'`,
          format: 'json',
        },
      )
      if (colResponse.status === 200 && Array.isArray(colResponse.data)) {
        for (const col of colResponse.data as Array<Record<string, unknown>>) {
          const dataType = String(col.data_type || '')
          if (dataType.includes('Dictionary')) {
            tagColumns.push(String(col.column_name))
          }
        }
      }
    } catch {
      logDebug(`Warning: Could not query column metadata for ${table}`)
    }

    // Query all data from the table
    const dataResponse = await influxdbApiRequest(
      port,
      'POST',
      '/api/v3/query_sql',
      {
        db: database,
        q: `SELECT * FROM "${table.replace(/"/g, '""')}"`,
        format: 'json',
      },
    )

    if (dataResponse.status !== 200) {
      logDebug(
        `Warning: Failed to export table ${table}: ${JSON.stringify(dataResponse.data)}`,
      )
      continue
    }

    const rows = dataResponse.data as Array<Record<string, unknown>>

    if (Array.isArray(rows) && rows.length > 0) {
      sqlContent += `-- Table: ${table}\n`
      if (tagColumns.length > 0) {
        sqlContent += `-- Tags: ${tagColumns.join(', ')}\n`
      }

      for (const row of rows) {
        const columns = Object.keys(row)
        const values = columns.map((col) => {
          const val = row[col]
          if (val === null || val === undefined) return 'NULL'
          if (typeof val === 'number') return String(val)
          if (typeof val === 'boolean') return val ? 'true' : 'false'
          return `'${String(val).replace(/'/g, "''")}'`
        })
        sqlContent += `INSERT INTO "${table.replace(/"/g, '""')}" (${columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')}) VALUES (${values.join(', ')});\n`
      }
      sqlContent += '\n'
    }
  }

  // Write SQL content to file
  await writeFile(outputPath, sqlContent, 'utf-8')

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'sql',
    size: stats.size,
  }
}
