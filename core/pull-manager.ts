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
import { unlink, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { withTransaction } from './transaction-manager'
import { containerManager } from './container-manager'
import { getEngine } from '../engines'
import { logDebug } from './error-handler'
import type { ContainerConfig, PullOptions, PullResult, Engine } from '../types'
import type { BaseEngine } from '../engines/base-engine'

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

    return withTransaction(async (tx) => {
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
          format: 'custom', // Compressed, fast restore for PostgreSQL
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
        await engine.restore(config, tempOriginalDump, {
          database: backupDatabase,
          createDatabase: false,
        })
      }

      // --- PULL REMOTE ---

      // Step 4: Dump remote to temp file
      logDebug(`Dumping remote database to: ${tempRemoteDump}`)
      await engine.dumpFromConnectionString(options.fromUrl, tempRemoteDump)
      tx.addRollback({
        description: 'Delete remote dump temp file',
        execute: async () => {
          try {
            await unlink(tempRemoteDump)
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
      await engine.restore(config, tempRemoteDump, {
        database: targetDatabase,
        createDatabase: false,
      })

      // Step 9: Update registry (add backup if we're keeping it)
      if (keepBackup) {
        await containerManager.addDatabase(config.name, backupDatabase)
      }

      // Step 10: Cleanup temp files
      try {
        await unlink(tempOriginalDump)
      } catch {
        // Ignore errors
      }
      try {
        await unlink(tempRemoteDump)
      } catch {
        // Ignore errors
      }

      // Step 11: Run post-script if provided
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
        message: keepBackup
          ? `Pulled remote data into "${targetDatabase}", backup at "${backupDatabase}"`
          : `Pulled remote data into "${targetDatabase}"`,
      }
    })
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
      await engine.dumpFromConnectionString(options.fromUrl, tempRemoteDump)
      tx.addRollback({
        description: 'Delete remote dump temp file',
        execute: async () => {
          try {
            await unlink(tempRemoteDump)
          } catch {
            // Ignore errors
          }
        },
      })

      // Step 4: Restore remote into target
      logDebug(`Restoring remote data into: ${targetDatabase}`)
      await engine.restore(config, tempRemoteDump, {
        database: targetDatabase,
        createDatabase: false,
      })

      // Step 5: Update registry
      await containerManager.addDatabase(config.name, targetDatabase)

      // Step 6: Cleanup
      try {
        await unlink(tempRemoteDump)
      } catch {
        // Ignore errors
      }

      // Step 7: Run post-script if provided
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

      return {
        success: true,
        mode: 'clone' as const,
        container: config.name,
        port: config.port,
        database: targetDatabase,
        databaseUrl: engine.getConnectionString(config, targetDatabase),
        source: this.redactUrl(options.fromUrl),
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

  private async databaseExists(
    config: ContainerConfig,
    database: string,
  ): Promise<boolean> {
    // Check against tracked databases in config
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
      message: '[DRY RUN] No changes made',
    }
  }
}

export const pullManager = new PullManager()
