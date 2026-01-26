/**
 * CouchDB backup module
 * Supports JSON-based backup using CouchDB's REST API
 *
 * CouchDB backup strategy:
 * - Export all documents from each database using _all_docs?include_docs=true
 * - Store as a JSON file with metadata about databases and their documents
 */

import { mkdir, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { couchdbApiRequest } from './api-client'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

// Backup operations may take longer than the default timeout
const BACKUP_TIMEOUT_MS = 600000 // 10 minutes

type CouchDBBackup = {
  version: string
  created: string
  databases: Array<{
    name: string
    docs: unknown[]
  }>
}

/**
 * Create a JSON backup of all databases using CouchDB's REST API
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port } = container
  const targetDatabase = options.database

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // Get CouchDB version info
  const infoResponse = await couchdbApiRequest(port, 'GET', '/')
  const serverInfo = infoResponse.data as { version?: string }
  const serverVersion = serverInfo?.version || 'unknown'

  // Get list of databases to backup
  let databasesToBackup: string[]

  if (targetDatabase) {
    // Backup specific database
    databasesToBackup = [targetDatabase]
  } else {
    // Backup all user databases (excluding system databases)
    const dbsResponse = await couchdbApiRequest(port, 'GET', '/_all_dbs')
    if (dbsResponse.status !== 200) {
      throw new Error(
        `Failed to list databases: ${JSON.stringify(dbsResponse.data)}`,
      )
    }
    const allDbs = dbsResponse.data as string[]
    // Filter out system databases (starting with _)
    databasesToBackup = allDbs.filter((db) => !db.startsWith('_'))
  }

  logDebug(`Backing up ${databasesToBackup.length} database(s)`)

  // Export documents from each database
  const backup: CouchDBBackup = {
    version: serverVersion,
    created: new Date().toISOString(),
    databases: [],
  }

  for (const dbName of databasesToBackup) {
    logDebug(`Exporting database: ${dbName}`)

    const docsResponse = await couchdbApiRequest(
      port,
      'GET',
      `/${encodeURIComponent(dbName)}/_all_docs?include_docs=true`,
      undefined,
      BACKUP_TIMEOUT_MS,
    )

    if (docsResponse.status !== 200) {
      throw new Error(
        `Failed to export database ${dbName}: ${JSON.stringify(docsResponse.data)}`,
      )
    }

    const docsData = docsResponse.data as {
      rows?: Array<{ doc?: unknown }>
    }
    const docs =
      docsData.rows
        ?.map((row) => row.doc)
        .filter((doc): doc is unknown => doc !== undefined) || []

    // Filter out design documents for cleaner backup (they start with _design/)
    const userDocs = docs.filter((doc) => {
      const d = doc as { _id?: string }
      return d._id && !d._id.startsWith('_design/')
    })

    backup.databases.push({
      name: dbName,
      docs: userDocs,
    })
  }

  // Write backup to file
  await writeFile(outputPath, JSON.stringify(backup, null, 2))

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'json',
    size: stats.size,
  }
}

/**
 * Create a backup for cloning purposes
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  // Backup all databases for cloning
  return createBackup(container, outputPath, { database: '' })
}
