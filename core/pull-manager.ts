/**
 * Pull Manager
 *
 * Handles pulling remote database data into local containers.
 * Supports two modes:
 * - Replace mode (default): Backs up original data, then replaces with remote
 * - Clone mode (--as flag): Creates a new database with remote data
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { rm, unlink, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { withTransaction } from './transaction-manager'
import { containerManager } from './container-manager'
import { getEngine } from '../engines'
import { logDebug } from './error-handler'
import { Engine } from '../types'
import type {
  ContainerConfig,
  PullOptions,
  PullResult,
  RemoteDumpOptions,
  RestoreResult,
} from '../types'
import type { BaseEngine } from '../engines/base-engine'
import { getDefaultFormat } from '../config/backup-formats'

/**
 * Engines whose remote dump tool can exclude tables/collections entirely
 * (--exclude-table). pg_dump: --exclude-table, mysqldump/mariadb-dump:
 * --ignore-table, mongodump: --excludeCollection.
 */
export const EXCLUDE_TABLES_ENGINES: Engine[] = [
  Engine.PostgreSQL,
  Engine.MySQL,
  Engine.MariaDB,
  Engine.MongoDB,
  Engine.FerretDB,
]

/**
 * Engines whose remote dump tool can keep a table's schema while skipping its
 * rows (--exclude-table-data). Only pg_dump supports this natively.
 */
export const EXCLUDE_TABLE_DATA_ENGINES: Engine[] = [Engine.PostgreSQL]

/**
 * Engines whose remote dump supports parallel workers (--jobs).
 * pg_dump -Fd -j N; the dump becomes a directory instead of a single file.
 */
export const PARALLEL_PULL_ENGINES: Engine[] = [Engine.PostgreSQL]

/** Parallel dump opens jobs+1 connections; keep a sane ceiling. */
export const MAX_PULL_JOBS = 8

/**
 * Validate --jobs against the engine and range. Throws with an actionable
 * message on unsupported combinations.
 */
export function validateJobsOption(engine: Engine, jobs?: number): void {
  if (jobs === undefined) return
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_PULL_JOBS) {
    throw new Error(
      `--jobs must be an integer between 1 and ${MAX_PULL_JOBS} (got ${jobs}).\n` +
        '  Parallel dump opens jobs+1 connections to the remote server.',
    )
  }
  if (jobs > 1 && !PARALLEL_PULL_ENGINES.includes(engine)) {
    throw new Error(
      `--jobs is not supported for ${engine}.\n` +
        `  Supported engines: ${PARALLEL_PULL_ENGINES.join(', ')}`,
    )
  }
}

/**
 * Validate --exclude-table / --exclude-table-data against the engine's
 * capabilities. Throws with an actionable message on unsupported combinations.
 */
export function validateExcludeOptions(
  engine: Engine,
  options: Pick<PullOptions, 'excludeTables' | 'excludeTableData'>,
): void {
  if (
    options.excludeTables?.length &&
    !EXCLUDE_TABLES_ENGINES.includes(engine)
  ) {
    throw new Error(
      `--exclude-table is not supported for ${engine}.\n` +
        `  Supported engines: ${EXCLUDE_TABLES_ENGINES.join(', ')}`,
    )
  }
  if (
    options.excludeTableData?.length &&
    !EXCLUDE_TABLE_DATA_ENGINES.includes(engine)
  ) {
    throw new Error(
      `--exclude-table-data is not supported for ${engine}.\n` +
        `  Supported engines: ${EXCLUDE_TABLE_DATA_ENGINES.join(', ')}\n` +
        '  To skip a table entirely (schema and data), use --exclude-table.',
    )
  }
}

/**
 * Package the pull options that the engine's remote dump understands.
 * Exported so tests can prove every option actually reaches the dump tool
 * (a private version of this once silently dropped `jobs`).
 */
export function buildRemoteDumpOptions(
  options: PullOptions,
): RemoteDumpOptions | undefined {
  const parallel = options.jobs !== undefined && options.jobs > 1
  if (
    !options.excludeTables?.length &&
    !options.excludeTableData?.length &&
    !parallel
  ) {
    return undefined
  }
  return {
    excludeTables: options.excludeTables,
    excludeTableData: options.excludeTableData,
    jobs: parallel ? options.jobs : undefined,
  }
}

/**
 * Restore implementations (notably PostgreSQL's) report failure by RESOLVING
 * with a non-zero code instead of throwing, because pg_restore can exit
 * non-zero on partial success. Inside pull that leniency is wrong: a failed
 * restore must abort and roll back, never report success over incomplete data.
 */
function assertRestoreSucceeded(result: RestoreResult, context: string): void {
  if (typeof result.code === 'number' && result.code !== 0) {
    const detail = result.stderr
      ? `\n  ${result.stderr.trim().split('\n').slice(-15).join('\n  ')}`
      : ''
    throw new Error(
      `Restore failed while ${context} (exit code ${result.code}).${detail}`,
    )
  }
}

/**
 * Context passed to post-pull scripts via SPINDB_CONTEXT env var.
 * Scripts can read this JSON file to get connection strings and metadata.
 */
export type PullContext = {
  container: string
  engine: Engine
  mode: 'replace' | 'clone'
  port: number
  /** The database containing the new (remote) data */
  newDatabase: string
  /** Connection string to the new database */
  newUrl: string
  /** The backup database containing original data (replace mode only) */
  originalDatabase?: string
  /** Connection string to the original/backup database (replace mode only) */
  originalUrl?: string
}

export class PullManager {
  /**
   * Pull remote database data into a local container
   */
  async pull(containerName: string, options: PullOptions): Promise<PullResult> {
    // 1. Get and validate container
    const config = await containerManager.getConfig(containerName)
    if (!config) {
      throw new Error(`Container "${containerName}" not found`)
    }
    if (config.status !== 'running') {
      throw new Error(
        `Container "${containerName}" is not running. Run: spindb start ${containerName}`,
      )
    }

    const engine = getEngine(config.engine)
    const timestamp = this.generateTimestamp()

    // Fail fast if table exclusion or parallel dump was requested on an
    // engine that can't do it
    validateExcludeOptions(config.engine, options)
    validateJobsOption(config.engine, options.jobs)

    // 2. Determine mode and target database
    const isCloneMode = !!options.asDatabase
    const targetDatabase = isCloneMode
      ? options.asDatabase!
      : options.database || config.database

    // 3. Validate
    if (!isCloneMode) {
      // Replace mode: target must exist
      const exists = await this.databaseExists(config, targetDatabase)
      if (!exists) {
        throw new Error(`Database "${targetDatabase}" does not exist`)
      }
    } else {
      // Clone mode: target must NOT exist (unless --force)
      const exists = await this.databaseExists(config, targetDatabase)
      if (exists && !options.force) {
        throw new Error(
          `Database "${targetDatabase}" already exists. Use --force to overwrite.`,
        )
      }
    }

    // 4. Dry run
    if (options.dryRun) {
      return this.dryRunResult(
        config,
        engine,
        targetDatabase,
        timestamp,
        options,
        isCloneMode,
      )
    }

    // 5. Execute with transaction
    if (isCloneMode) {
      return this.executeCloneMode(config, engine, targetDatabase, options)
    } else {
      return this.executeReplaceMode(
        config,
        engine,
        targetDatabase,
        timestamp,
        options,
      )
    }
  }

  private async executeReplaceMode(
    config: ContainerConfig,
    engine: BaseEngine,
    targetDatabase: string,
    timestamp: string,
    options: PullOptions,
  ): Promise<PullResult> {
    const backupDatabase = `${targetDatabase}_${timestamp}`
    const tempOriginalDump = join(tmpdir(), `spindb-orig-${timestamp}.dump`)
    const tempRemoteDump = join(tmpdir(), `spindb-remote-${timestamp}.dump`)

    // Always create backup if there's a post-script (so it can access original data)
    // Otherwise, only create backup if --no-backup wasn't specified
    const needsBackup = !options.noBackup || !!options.postScript
    // Track whether to keep backup in final result (user didn't specify --no-backup)
    const keepBackup = !options.noBackup

    const result = await withTransaction(async (tx) => {
      // --- BACKUP ORIGINAL (always if post-script, otherwise if not --no-backup) ---
      if (needsBackup) {
        // Step 1: Create backup database
        logDebug(`Creating backup database: ${backupDatabase}`)
        await engine.createDatabase(config, backupDatabase)
        tx.addRollback({
          description: `Drop backup database "${backupDatabase}"`,
          execute: async () => {
            try {
              await engine.dropDatabase(config, backupDatabase)
            } catch {
              // Ignore errors
            }
          },
        })

        // Step 2: Dump original to temp file (using existing backup method)
        logDebug(`Dumping original database to: ${tempOriginalDump}`)
        await engine.backup(config, tempOriginalDump, {
          database: targetDatabase,
          format: getDefaultFormat(config.engine),
        })
        tx.addRollback({
          description: 'Delete original dump temp file',
          execute: async () => {
            try {
              await unlink(tempOriginalDump)
            } catch {
              // Ignore errors
            }
          },
        })

        // Step 3: Restore original into backup
        logDebug(`Restoring original into backup database: ${backupDatabase}`)
        const backupRestore = await engine.restore(config, tempOriginalDump, {
          database: backupDatabase,
          createDatabase: false,
        })
        assertRestoreSucceeded(
          backupRestore,
          `copying the original into backup database "${backupDatabase}"`,
        )
      }

      // --- PULL REMOTE ---

      // Step 4: Dump remote to temp file
      logDebug(`Dumping remote database to: ${tempRemoteDump}`)
      await engine.dumpFromConnectionString(
        options.fromUrl,
        tempRemoteDump,
        buildRemoteDumpOptions(options),
      )
      tx.addRollback({
        description: 'Delete remote dump temp file',
        execute: async () => {
          try {
            await rm(tempRemoteDump, { recursive: true, force: true })
          } catch {
            // Ignore errors
          }
        },
      })

      // Step 5: Terminate connections to original
      logDebug(`Terminating connections to: ${targetDatabase}`)
      await engine.terminateConnections(config, targetDatabase)

      // Step 6: Drop original database
      logDebug(`Dropping original database: ${targetDatabase}`)
      await engine.dropDatabase(config, targetDatabase)
      tx.addRollback({
        description: `Restore original database "${targetDatabase}" from backup`,
        execute: async () => {
          if (needsBackup) {
            // Restore from backup
            try {
              await engine.createDatabase(config, targetDatabase)
              await engine.restore(config, tempOriginalDump, {
                database: targetDatabase,
                createDatabase: false,
              })
            } catch {
              // Ignore errors
            }
          }
        },
      })

      // Step 7: Create fresh original database
      logDebug(`Creating fresh database: ${targetDatabase}`)
      await engine.createDatabase(config, targetDatabase)

      // Step 8: Restore remote into original
      logDebug(`Restoring remote data into: ${targetDatabase}`)
      const remoteRestore = await engine.restore(config, tempRemoteDump, {
        database: targetDatabase,
        createDatabase: false,
        jobs: options.jobs,
      })
      assertRestoreSucceeded(
        remoteRestore,
        `loading remote data into "${targetDatabase}"`,
      )

      // Step 9: Cleanup temp files
      try {
        await unlink(tempOriginalDump)
      } catch {
        // Ignore errors
      }
      try {
        await rm(tempRemoteDump, { recursive: true, force: true })
      } catch {
        // Ignore errors
      }

      // Step 10: Run post-script if provided
      if (options.postScript) {
        const context: PullContext = {
          container: config.name,
          engine: config.engine,
          mode: 'replace',
          port: config.port,
          newDatabase: targetDatabase,
          newUrl: engine.getConnectionString(config, targetDatabase),
          originalDatabase: backupDatabase,
          originalUrl: engine.getConnectionString(config, backupDatabase),
        }

        await this.runPostScript(options.postScript, context)

        // If --no-backup was specified, drop the temporary backup after successful script
        if (!keepBackup) {
          logDebug(`Dropping temporary backup database: ${backupDatabase}`)
          try {
            await engine.terminateConnections(config, backupDatabase)
            await engine.dropDatabase(config, backupDatabase)
          } catch {
            // Ignore errors - backup cleanup is best-effort
          }
        }
      }

      return {
        success: true,
        mode: 'replace' as const,
        container: config.name,
        port: config.port,
        database: targetDatabase,
        databaseUrl: engine.getConnectionString(config, targetDatabase),
        backupDatabase: keepBackup ? backupDatabase : undefined,
        backupUrl: keepBackup
          ? engine.getConnectionString(config, backupDatabase)
          : undefined,
        source: this.redactUrl(options.fromUrl),
        excludedTables: options.excludeTables?.length
          ? options.excludeTables
          : undefined,
        excludedTableData: options.excludeTableData?.length
          ? options.excludeTableData
          : undefined,
        message: keepBackup
          ? `Pulled remote data into "${targetDatabase}", backup at "${backupDatabase}"`
          : `Pulled remote data into "${targetDatabase}"`,
      }
    })

    // Sync registry with actual databases on server after transaction commits
    // This captures the backup database (if kept) and any other databases
    // Wrapped in try/catch to avoid affecting the main pull result on transient failures
    try {
      await containerManager.syncDatabases(config.name)
    } catch (error) {
      logDebug(
        `Failed to sync databases for "${config.name}": ${error instanceof Error ? error.message : error}`,
      )
    }

    return result
  }

  private async executeCloneMode(
    config: ContainerConfig,
    engine: BaseEngine,
    targetDatabase: string,
    options: PullOptions,
  ): Promise<PullResult> {
    const timestamp = this.generateTimestamp()
    const tempRemoteDump = join(tmpdir(), `spindb-remote-${timestamp}.dump`)

    return withTransaction(async (tx) => {
      // Step 1: Drop target if exists (--force required)
      if (options.force) {
        try {
          await engine.terminateConnections(config, targetDatabase)
          await engine.dropDatabase(config, targetDatabase)
        } catch {
          // Ignore errors
        }
      }

      // Step 2: Create target database
      logDebug(`Creating target database: ${targetDatabase}`)
      await engine.createDatabase(config, targetDatabase)
      tx.addRollback({
        description: `Drop target database "${targetDatabase}"`,
        execute: async () => {
          try {
            await engine.dropDatabase(config, targetDatabase)
          } catch {
            // Ignore errors
          }
        },
      })

      // Step 3: Dump remote to temp file
      logDebug(`Dumping remote database to: ${tempRemoteDump}`)
      await engine.dumpFromConnectionString(
        options.fromUrl,
        tempRemoteDump,
        buildRemoteDumpOptions(options),
      )
      tx.addRollback({
        description: 'Delete remote dump temp file',
        execute: async () => {
          try {
            await rm(tempRemoteDump, { recursive: true, force: true })
          } catch {
            // Ignore errors
          }
        },
      })

      // Step 4: Restore remote into target
      logDebug(`Restoring remote data into: ${targetDatabase}`)
      const remoteRestore = await engine.restore(config, tempRemoteDump, {
        database: targetDatabase,
        createDatabase: false,
        jobs: options.jobs,
      })
      assertRestoreSucceeded(
        remoteRestore,
        `loading remote data into "${targetDatabase}"`,
      )

      // Step 5: Cleanup
      try {
        await rm(tempRemoteDump, { recursive: true, force: true })
      } catch {
        // Ignore errors
      }

      // Step 6: Run post-script if provided
      if (options.postScript) {
        const context: PullContext = {
          container: config.name,
          engine: config.engine,
          mode: 'clone',
          port: config.port,
          newDatabase: targetDatabase,
          newUrl: engine.getConnectionString(config, targetDatabase),
          // Clone mode has no original database (we're creating a new one)
        }

        await this.runPostScript(options.postScript, context)
      }

      // Step 7: Sync registry with actual databases on server
      // Wrapped in try/catch to avoid rolling back a successful clone on transient failures
      try {
        await containerManager.syncDatabases(config.name)
      } catch (error) {
        logDebug(
          `Failed to sync databases for "${config.name}": ${error instanceof Error ? error.message : error}`,
        )
      }

      return {
        success: true,
        mode: 'clone' as const,
        container: config.name,
        port: config.port,
        database: targetDatabase,
        databaseUrl: engine.getConnectionString(config, targetDatabase),
        source: this.redactUrl(options.fromUrl),
        excludedTables: options.excludeTables?.length
          ? options.excludeTables
          : undefined,
        excludedTableData: options.excludeTableData?.length
          ? options.excludeTableData
          : undefined,
        message: `Cloned remote data into new database "${targetDatabase}"`,
      }
    })
  }

  private async runPostScript(
    scriptPath: string,
    context: PullContext,
  ): Promise<void> {
    logDebug(`Running post-pull script: ${scriptPath}`)

    // Write context to temp JSON file so scripts can read it
    const contextFile = join(
      tmpdir(),
      `spindb-context-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    )
    await writeFile(contextFile, JSON.stringify(context, null, 2), 'utf-8')

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(scriptPath, [], {
          env: {
            ...process.env,
            // New: JSON context file with connection strings
            SPINDB_CONTEXT: contextFile,
            // Legacy env vars for backward compatibility
            SPINDB_CONTAINER: context.container,
            SPINDB_DATABASE: context.newDatabase,
            SPINDB_BACKUP_DATABASE: context.originalDatabase || '',
            SPINDB_PORT: String(context.port),
            SPINDB_ENGINE: context.engine,
          },
          stdio: 'inherit',
        })

        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`Post-pull script exited with code ${code}`))
          }
        })

        proc.on('error', reject)
      })
    } finally {
      // Clean up context file
      try {
        await unlink(contextFile)
      } catch {
        // Ignore errors
      }
    }
  }

  private generateTimestamp(): string {
    const now = new Date()
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')
  }

  private redactUrl(url: string): string {
    try {
      const parsed = new URL(url)
      if (parsed.password) parsed.password = '***'
      return parsed.toString()
    } catch {
      return '[invalid url]'
    }
  }

  /**
   * Check if a database exists in SpinDB's tracking.
   *
   * Note: This only checks SpinDB's tracked databases, not the actual database server.
   * Databases created outside SpinDB (e.g., via psql) won't be detected.
   * Use `spindb databases add` to track externally created databases.
   */
  private async databaseExists(
    config: ContainerConfig,
    database: string,
  ): Promise<boolean> {
    const tracked = config.databases || [config.database]
    if (tracked.includes(database)) return true

    // Also check if it's the primary database
    if (database === config.database) return true

    return false
  }

  private dryRunResult(
    config: ContainerConfig,
    engine: BaseEngine,
    database: string,
    timestamp: string,
    options: PullOptions,
    isCloneMode: boolean,
  ): PullResult {
    const backupDatabase = isCloneMode ? undefined : `${database}_${timestamp}`
    const keepBackup = !options.noBackup && !isCloneMode
    return {
      success: true,
      mode: isCloneMode ? 'clone' : 'replace',
      container: config.name,
      port: config.port,
      database,
      databaseUrl: engine.getConnectionString(config, database),
      backupDatabase: keepBackup ? backupDatabase : undefined,
      backupUrl: keepBackup
        ? engine.getConnectionString(config, backupDatabase!)
        : undefined,
      source: this.redactUrl(options.fromUrl),
      excludedTables: options.excludeTables?.length
        ? options.excludeTables
        : undefined,
      excludedTableData: options.excludeTableData?.length
        ? options.excludeTableData
        : undefined,
      message: '[DRY RUN] No changes made',
    }
  }
}

export const pullManager = new PullManager()
