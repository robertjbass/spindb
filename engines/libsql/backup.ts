/**
 * libSQL backup module
 * Supports binary (file copy) and SQL dump backup formats
 */

import { mkdir, stat, cp } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import {
  loadCredentials,
  getDefaultUsername,
} from '../../core/credential-manager'
import { libsqlQuery } from './api-client'
import {
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
  type LibSQLFormat,
} from '../../types'
import { writeFile } from 'fs/promises'

/**
 * Create a backup of a libSQL database
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const format = (options.format || 'binary') as LibSQLFormat

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  if (format === 'binary') {
    return createBinaryBackup(container, outputPath)
  }

  return createSqlBackup(container, outputPath)
}

/**
 * Create a binary backup by copying the database directory.
 * sqld's --db-path creates a directory tree (data.db/dbs/default/data is the
 * actual SQLite file, plus WAL, metastore, etc.). We copy the whole directory
 * to preserve all state needed for a clean restore.
 */
async function createBinaryBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  const containerDir = paths.getContainerPath(container.name, {
    engine: 'libsql',
  })
  const dbDir = join(containerDir, 'data', 'data.db')

  if (!existsSync(dbDir)) {
    throw new Error(
      `Database directory not found: ${dbDir}. Is the container initialized?`,
    )
  }

  logDebug(`Creating binary backup of libSQL database: ${dbDir}`)

  // Copy the entire data.db directory tree
  await cp(dbDir, outputPath, { recursive: true })

  // Calculate total size of the backup
  let totalSize = 0
  const isDir = statSync(outputPath).isDirectory()
  if (isDir) {
    const { readdir } = await import('fs/promises')
    async function sumDir(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          await sumDir(fullPath)
        } else {
          totalSize += (await stat(fullPath)).size
        }
      }
    }
    await sumDir(outputPath)
  } else {
    totalSize = (await stat(outputPath)).size
  }

  return {
    path: outputPath,
    format: 'binary',
    size: totalSize,
  }
}

/**
 * Create a SQL dump backup via the HTTP API
 */
async function createSqlBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  const { port, name } = container

  logDebug(
    `Creating SQL backup of libSQL database via HTTP API on port ${port}`,
  )

  // Load auth token if credentials are stored
  const username = getDefaultUsername(Engine.LibSQL)
  const creds = await loadCredentials(name, Engine.LibSQL, username)
  const authToken = creds?.apiKey ?? undefined

  // Get all table names
  const tablesResult = await libsqlQuery(
    port,
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream_%' ORDER BY name",
    { authToken },
  )

  const lines: string[] = [
    '-- libSQL SQL dump',
    `-- Server port: ${port}`,
    `-- Date: ${new Date().toISOString()}`,
    '',
    'BEGIN TRANSACTION;',
    '',
  ]

  for (const row of tablesResult.rows) {
    const tableName = String(row[0]?.type === 'text' ? row[0].value : row[0])
    const createSql = String(row[1]?.type === 'text' ? row[1].value : row[1])
    const escapedName = tableName.replace(/"/g, '""')

    lines.push(`${createSql};`)
    lines.push('')

    // Dump all rows
    const dataResult = await libsqlQuery(
      port,
      `SELECT * FROM "${escapedName}"`,
      { authToken },
    )

    for (const dataRow of dataResult.rows) {
      const values = dataRow.map((val) => {
        if (val.type === 'null') return 'NULL'
        if (val.type === 'integer') return val.value
        if (val.type === 'float') return String(val.value)
        if (val.type === 'text')
          return `'${String(val.value).replace(/'/g, "''")}'`
        if (val.type === 'blob') return `X'${val.base64}'`
        return 'NULL'
      })

      const columns = dataResult.cols.map(
        (c) => `"${c.name.replace(/"/g, '""')}"`,
      )
      lines.push(
        `INSERT INTO "${escapedName}" (${columns.join(', ')}) VALUES (${values.join(', ')});`,
      )
    }

    lines.push('')
  }

  // Get indexes
  const indexResult = await libsqlQuery(
    port,
    "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
    { authToken },
  )
  for (const row of indexResult.rows) {
    const sql = String(row[0]?.type === 'text' ? row[0].value : row[0])
    lines.push(`${sql};`)
  }

  // Get views
  const viewResult = await libsqlQuery(
    port,
    "SELECT sql FROM sqlite_master WHERE type='view' ORDER BY name",
    { authToken },
  )
  for (const row of viewResult.rows) {
    const sql = String(row[0]?.type === 'text' ? row[0].value : row[0])
    lines.push(`${sql};`)
  }

  // Get triggers
  const triggerResult = await libsqlQuery(
    port,
    "SELECT sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    { authToken },
  )
  for (const row of triggerResult.rows) {
    const sql = String(row[0]?.type === 'text' ? row[0].value : row[0])
    lines.push(`${sql};`)
  }

  lines.push('')
  lines.push('COMMIT;')
  lines.push('')

  const content = lines.join('\n')
  await writeFile(outputPath, content, 'utf-8')

  const stats = await stat(outputPath)
  return {
    path: outputPath,
    format: 'sql',
    size: stats.size,
  }
}
