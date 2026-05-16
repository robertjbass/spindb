/**
 * CouchDB restore module
 * Supports JSON-based restore using CouchDB's REST API
 */

import { readFile, open } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { logDebug } from '../../core/error-handler'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { couchdbApiRequest } from './api-client'
import { Engine, type BackupFormat, type RestoreResult } from '../../types'

// Restore operations may take longer than the default timeout
const RESTORE_TIMEOUT_MS = 600000 // 10 minutes

type CouchDBBackup = {
  version: string
  created: string
  databases: Array<{
    name: string
    docs: unknown[]
  }>
}

/**
 * Detect backup format from file
 * CouchDB backups are JSON files
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
      description: 'Directory found - CouchDB uses single JSON files',
      restoreCommand: 'CouchDB requires a single .json file for restore',
    }
  }

  // Check file extension
  if (filePath.endsWith('.json') || filePath.endsWith('.couchdb')) {
    return {
      format: 'json',
      description: 'CouchDB JSON backup',
      restoreCommand: 'spindb restore handles this automatically',
    }
  }

  // Check file contents for JSON structure
  try {
    const buffer = Buffer.alloc(100)
    const fd = await open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 100, 0)
      const content = buffer.toString('utf-8').trim()

      // Check if it looks like our backup format
      if (content.startsWith('{') && content.includes('"version"')) {
        return {
          format: 'json',
          description: 'CouchDB JSON backup (detected by content)',
          restoreCommand: 'spindb restore handles this automatically',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`Error reading backup file header: ${error}`)
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use .json or .couchdb file for restore',
  }
}

// Restore options for CouchDB
export type RestoreOptions = {
  containerName?: string
  port: number
  database?: string
  flush?: boolean
}

/**
 * Restore from JSON backup
 *
 * @param backupPath - Path to the backup file
 * @param options - Restore options including port and optional target database
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database: targetDatabase, flush } = options
  const savedCreds = options.containerName
    ? await loadCredentials(
        options.containerName,
        Engine.CouchDB,
        getDefaultUsername(Engine.CouchDB),
      )
    : null
  const auth = savedCreds
    ? {
        username: savedCreds.username,
        password: savedCreds.password,
      }
    : undefined

  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  if (format.format !== 'json') {
    throw new Error(
      `Invalid backup format: ${format.format}. Use .json or .couchdb file for restore.`,
    )
  }

  // Read and parse backup file
  const content = await readFile(backupPath, 'utf-8')
  let backup: CouchDBBackup

  try {
    backup = JSON.parse(content) as CouchDBBackup
  } catch (error) {
    throw new Error(`Invalid backup file: failed to parse JSON - ${error}`)
  }

  if (!backup.databases || !Array.isArray(backup.databases)) {
    throw new Error('Invalid backup file: missing databases array')
  }

  logDebug(`Restoring ${backup.databases.length} database(s) from backup`)

  // CouchDB's chttpd HTTP listener answers `GET /` before the cluster
  // machinery (mem3/fabric) finishes bootstrapping. If the caller hands us a
  // freshly-started node, the very first DB lookup or PUT can race the init
  // and return 5xx (e.g. `{"error":"no_majority"}`). Block until the node
  // proves it can answer DB lookups deterministically before we touch any
  // real data.
  await waitForCouchDBReady(port, auth)

  let restoredCount = 0
  const errors: string[] = []

  for (const dbBackup of backup.databases) {
    // Skip if targeting a specific database and this isn't it
    if (targetDatabase && dbBackup.name !== targetDatabase) {
      continue
    }

    const dbName = dbBackup.name
    logDebug(
      `Restoring database: ${dbName} (${dbBackup.docs.length} documents)`,
    )

    // Check if database exists. Retry briefly on transient cluster-init
    // errors so we can distinguish "doesn't exist" from "node not ready yet".
    const checkResponse = await getDatabaseStatusWithRetry(port, dbName, auth)

    if (checkResponse.status === 200) {
      if (flush) {
        // Delete existing database
        const deleteResponse = await couchdbApiRequest(
          port,
          'DELETE',
          `/${encodeURIComponent(dbName)}`,
          undefined,
          undefined,
          auth,
        )
        // Accept 200 (OK) or 202 (Accepted) for async deletes
        if (deleteResponse.status !== 200 && deleteResponse.status !== 202) {
          errors.push(
            `Failed to delete existing database ${dbName}: ${JSON.stringify(deleteResponse.data)}`,
          )
          continue
        }
      } else {
        logDebug(`Database ${dbName} exists, merging documents`)
      }
    } else if (checkResponse.status !== 404) {
      // Anything other than 200 (exists) or 404 (clean) is a hard failure —
      // do NOT silently fall through to bulk_docs against a missing DB. This
      // was the original BUG-9 footgun: a 5xx from a half-initialized cluster
      // caused the PUT branch below to be skipped, restore to "succeed" with
      // code:1 stderr, and the calling test to see an empty database list.
      errors.push(
        `Unexpected status ${checkResponse.status} checking database ${dbName}: ${JSON.stringify(checkResponse.data)}`,
      )
      continue
    }

    // Create database if it doesn't exist (or was just deleted)
    if (checkResponse.status === 404 || flush) {
      const createResponse = await couchdbApiRequest(
        port,
        'PUT',
        `/${encodeURIComponent(dbName)}`,
        undefined,
        undefined,
        auth,
      )
      if (createResponse.status !== 201 && createResponse.status !== 412) {
        // 412 means database already exists, which is fine
        errors.push(
          `Failed to create database ${dbName}: ${JSON.stringify(createResponse.data)}`,
        )
        continue
      }
    }

    // Prepare documents for bulk insert
    // Remove _rev to allow inserting as new documents
    const docsToInsert = dbBackup.docs.map((doc) => {
      const d = doc as Record<string, unknown>
      const { _rev: _, ...rest } = d
      return rest
    })

    if (docsToInsert.length === 0) {
      logDebug(`No documents to restore for ${dbName}`)
      restoredCount++
      continue
    }

    // Bulk insert documents
    const bulkResponse = await couchdbApiRequest(
      port,
      'POST',
      `/${encodeURIComponent(dbName)}/_bulk_docs`,
      { docs: docsToInsert },
      RESTORE_TIMEOUT_MS,
      auth,
    )

    if (bulkResponse.status !== 201) {
      errors.push(
        `Failed to restore documents to ${dbName}: ${JSON.stringify(bulkResponse.data)}`,
      )
      continue
    }

    restoredCount++
    logDebug(`Restored ${docsToInsert.length} documents to ${dbName}`)
  }

  const message =
    `Restored ${restoredCount} database(s)` +
    (errors.length > 0 ? ` with ${errors.length} error(s)` : '')

  // Surface errors loudly instead of returning code:1 and letting the caller
  // assume success. Silently returning success-with-stderr is what allowed
  // BUG-9 to slip past the clone integration test on macOS x64.
  if (errors.length > 0) {
    throw new Error(`CouchDB restore failed: ${errors.join('; ')}`)
  }

  return {
    format: 'json',
    stdout: message,
    stderr: undefined,
    code: 0,
  }
}

/**
 * Poll CouchDB until the node is fully bootstrapped and can answer database
 * lookups. Combines `/_up` (returns `status:"ok"` once the node is ready)
 * with a synthetic GET against a known-nonexistent database (must return 404,
 * not 5xx). The combination proves that mem3/fabric are up, not just chttpd.
 */
async function waitForCouchDBReady(
  port: number,
  auth: { username: string; password: string } | undefined,
  timeoutMs = 30000,
): Promise<void> {
  const startTime = Date.now()
  const checkInterval = 250
  let lastFailure = 'no probe attempted'

  while (Date.now() - startTime < timeoutMs) {
    try {
      const up = await couchdbApiRequest(
        port,
        'GET',
        '/_up',
        undefined,
        5000,
        auth ?? null,
      )
      if (up.status === 200) {
        const data = up.data as { status?: string } | null
        if (data?.status === 'ok') {
          const probe = await couchdbApiRequest(
            port,
            'GET',
            '/_spindb_restore_probe',
            undefined,
            5000,
            auth ?? null,
          )
          if (probe.status === 404 || probe.status === 401) {
            return
          }
          lastFailure = `db-lookup probe returned ${probe.status}`
        } else {
          lastFailure = `/_up status was ${data?.status ?? 'undefined'}`
        }
      } else {
        lastFailure = `/_up returned ${up.status}`
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval))
  }

  throw new Error(
    `CouchDB on port ${port} did not become ready within ${timeoutMs}ms ` +
      `(last failure: ${lastFailure})`,
  )
}

/**
 * Issue `GET /{db}` with a short retry loop. Transient 5xx responses can
 * happen if the node is still settling — we don't want a one-off blip to
 * cascade into a silent restore failure.
 */
async function getDatabaseStatusWithRetry(
  port: number,
  dbName: string,
  auth: { username: string; password: string } | undefined,
  maxAttempts = 5,
): Promise<{ status: number; data: unknown }> {
  let lastResponse: { status: number; data: unknown } | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await couchdbApiRequest(
      port,
      'GET',
      `/${encodeURIComponent(dbName)}`,
      undefined,
      undefined,
      auth,
    )
    if (response.status === 200 || response.status === 404) {
      return response
    }
    lastResponse = response
    logDebug(
      `CouchDB GET /${dbName} returned ${response.status}, retrying (${attempt + 1}/${maxAttempts})`,
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return lastResponse ?? { status: 0, data: null }
}

/**
 * Parse CouchDB connection string
 * Format: http://host[:port][/database] or https://host[:port][/database]
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'https'
  database?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid CouchDB connection string: expected a non-empty string',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `Invalid CouchDB connection string: "${connectionString}". ` +
        `Expected format: http://host[:port][/database]`,
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
      `Invalid CouchDB connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "http://" or "https://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 5984

  // Extract database from pathname (e.g., /mydb)
  const pathname = url.pathname || ''
  const database =
    pathname.length > 1 ? pathname.slice(1).split('/')[0] : undefined

  return {
    host,
    port,
    protocol,
    database,
  }
}
