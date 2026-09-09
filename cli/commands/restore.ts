import { Command } from 'commander'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import {
  promptContainerSelect,
  promptDatabaseName,
  promptInstallDependencies,
  promptConfirm,
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiSuccess, uiError, uiWarning } from '../ui/theme'
import { tmpdir } from 'os'
import { join } from 'path'
import { getMissingDependencies } from '../../core/dependency-manager'
import { getDumpToolName } from '../../config/engines-registry'
import { platformService } from '../../core/platform-service'
import { TransactionManager } from '../../core/transaction-manager'
import {
  Engine,
  isFileBasedEngine,
  isRemoteContainer,
  restoreCreatesDatabase,
  type RemoteDumpSourceInfo,
} from '../../types'
import { logDebug, describeThrown } from '../../core/error-handler'
import {
  classifyRestoreOutcome,
  restoreDiagnosticsJson,
  restoreErrorReportLines,
  restoreFailureMessage,
  type RestoreOutcome,
} from '../../core/restore-outcome'
import { getEngineMetadata } from '../helpers'
import {
  copyRedisKeyspace,
  type RedisCopyProgress,
} from '../../engines/redis/resp-client'
import { parseRedisConnectionString } from '../../engines/redis'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'

export const restoreCommand = new Command('restore')
  .description('Restore a backup to a container')
  .argument('[name]', 'Container name')
  .argument(
    '[backup]',
    'Path to backup file (not required if using --from-url)',
  )
  .option('-d, --database <name>', 'Target database name')
  .option(
    '--from-url <url>',
    'Pull data from a remote database connection string',
  )
  .option('-f, --force', 'Overwrite existing database without confirmation')
  .option(
    '--into-existing',
    'Restore INTO an existing database without dropping/recreating it (non-destructive to the database object; replaces its contents). The database must already exist. Safe to run against a live database with open connections (e.g. behind a connection pooler).',
  )
  .option(
    '--pre-sql <file>',
    'Run a SQL file against the target database after it is created and BEFORE the restore. For compatibility shims a dump needs and the target lacks: a missing extension, roles the dump grants to, a function a column default calls. Runs inside the same rollback scope as the restore.',
  )
  .option(
    '--with-privileges',
    'Replay the GRANT/REVOKE statements in the dump instead of dropping them. PostgreSQL only, and only for custom/tar/directory dumps (a plain-SQL dump is replayed as written, so its grants always ran). Object ownership is still stripped. A grant to a role this container does not have becomes a reported object error rather than silence.',
  )
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (
      name: string | undefined,
      backup: string | undefined,
      options: {
        database?: string
        fromUrl?: string
        force?: boolean
        intoExisting?: boolean
        preSql?: string
        withPrivileges?: boolean
        json?: boolean
      },
    ) => {
      let tempDumpPath: string | null = null
      // Which tool the remote dump actually ran, when the engine had to
      // choose one (a `mysql://` source can be MySQL or MariaDB). Surfaced in
      // --json so a conversion is visible to a script, not just to a reader.
      let remoteSource: RemoteDumpSourceInfo | undefined
      // Whether --pre-sql ran, and how the restore itself turned out. Both are
      // reported in --json.
      let preSqlApplied = false
      let outcome: RestoreOutcome | undefined

      try {
        let containerName = name
        let backupPath = backup

        if (!containerName) {
          // JSON mode requires container name argument
          if (options.json) {
            console.log(JSON.stringify({ error: 'Container name is required' }))
            process.exit(1)
          }

          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            if (containers.length === 0) {
              console.log(
                uiWarning(
                  'No containers found. Create one with: spindb create',
                ),
              )
            } else {
              console.log(
                uiWarning(
                  'No running containers. Start one first with: spindb start',
                ),
              )
            }
            return
          }

          const selected = await promptContainerSelect(
            running,
            'Select container to restore to:',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error: `Container "${containerName}" not found`,
              }),
            )
          } else {
            console.error(uiError(`Container "${containerName}" not found`))
          }
          process.exit(1)
        }

        // Block restore for remote containers (dangerous for production DBs)
        if (isRemoteContainer(config)) {
          const errorMsg = `Restore is not available for linked remote containers. This protects against accidental data loss on remote databases.`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        const { engine: engineName } = config
        const engine = getEngine(engineName)

        // --into-existing does a faithful in-place REPLACE only for engines
        // whose restore drops + recreates each object (so the contents are
        // replaced, not merged into). This allowlist grows one engine at a time
        // as each gets clean-restore support plus an integration round-trip test
        // - never silently merge on an engine that can't replace.
        const INTO_EXISTING_ENGINES = new Set([
          'postgresql',
          'mysql',
          'mariadb',
          'mongodb',
          'ferretdb',
          'cockroachdb',
          'clickhouse',
          'questdb',
        ])
        if (options.intoExisting && !INTO_EXISTING_ENGINES.has(engineName)) {
          const msg = `--into-existing is not yet supported for ${engineName}. Restore without it (drop + recreate the database) instead.`
          if (options.json) {
            console.log(JSON.stringify({ error: msg }))
          } else {
            console.log(chalk.red(`\n  ${msg}\n`))
          }
          process.exit(1)
        }

        // --pre-sql runs a SQL file through the engine's own client. The
        // allowlist is the set of engines whose client can be told to keep its
        // chatter off stdout (runScript's `quiet`), because --pre-sql --json
        // has to stay parseable.
        const PRE_SQL_ENGINES = new Set(['postgresql', 'mysql', 'mariadb'])
        if (options.preSql) {
          if (!PRE_SQL_ENGINES.has(engineName)) {
            const msg = `--pre-sql is not supported for ${engineName}. It is available for ${[...PRE_SQL_ENGINES].join(', ')}.`
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }
          if (!existsSync(options.preSql)) {
            const msg = `--pre-sql file not found: ${options.preSql}`
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }
        }

        // --with-privileges only means anything where the restore tool can be
        // told to drop privileges in the first place, which is pg_restore.
        if (options.withPrivileges && engineName !== Engine.PostgreSQL) {
          const msg = `--with-privileges is not supported for ${engineName}. It is available for postgresql, whose restore drops the dump's GRANT/REVOKE statements by default.`
          if (options.json) {
            console.log(JSON.stringify({ error: msg }))
          } else {
            console.error(uiError(msg))
          }
          process.exit(1)
        }

        // Check if container needs to be running for restore
        // - File-based engines (SQLite, DuckDB) don't need to be running
        // - Redis/Valkey RDB restore requires container to be STOPPED (text format needs running)
        // - Qdrant snapshot restore requires container to be STOPPED
        // - All other engines require container to be running
        // We defer the running check until after format detection for Redis/Valkey
        const isRedisLike = engineName === 'redis' || engineName === 'valkey'
        const isQdrant = engineName === 'qdrant'

        if (isQdrant) {
          // Qdrant snapshot restore requires the container to be stopped
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (running) {
            const errorMsg =
              `Container "${containerName}" must be stopped for Qdrant snapshot restore.\n` +
              `Run: spindb stop ${containerName}\n\n` +
              `Note: Restoring a Qdrant snapshot will replace all existing collections.`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        } else if (!isFileBasedEngine(engineName) && !isRedisLike) {
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            const errorMsg = `Container "${containerName}" is not running. Start it first.`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        const depsSpinner = createSpinner('Checking required tools...')
        depsSpinner.start()

        let missingDeps = await getMissingDependencies(config.engine)
        if (missingDeps.length > 0) {
          depsSpinner.warn(
            `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
          )

          const installed = await promptInstallDependencies(
            missingDeps[0].binary,
            config.engine,
          )

          if (!installed) {
            process.exit(1)
          }

          missingDeps = await getMissingDependencies(config.engine)
          if (missingDeps.length > 0) {
            console.error(
              uiError(
                `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
              ),
            )
            process.exit(1)
          }

          console.log(chalk.green('  ✓ All required tools are now available'))
          console.log()
        } else {
          depsSpinner.succeed('Required tools available')
        }

        if (options.fromUrl) {
          const isPgUrl =
            options.fromUrl.startsWith('postgresql://') ||
            options.fromUrl.startsWith('postgres://')
          const isMysqlUrl = options.fromUrl.startsWith('mysql://')
          const isRedisUrl =
            options.fromUrl.startsWith('redis://') ||
            options.fromUrl.startsWith('rediss://')

          if (engineName === 'postgresql' && !isPgUrl) {
            const msg =
              'Connection string must start with postgresql:// or postgres:// for PostgreSQL containers'
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }

          if (engineName === 'mysql' && !isMysqlUrl) {
            const msg =
              'Connection string must start with mysql:// for MySQL containers'
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }

          if (isRedisLike && !isRedisUrl) {
            const msg =
              'Connection string must start with redis:// or rediss:// for Redis/Valkey containers'
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }

          if (!isPgUrl && !isMysqlUrl && !isRedisUrl) {
            const msg =
              'Connection string must start with postgresql://, postgres://, mysql://, redis://, or rediss://'
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }

          // Redis/Valkey: a binary-safe SCAN + DUMP/PTTL -> RESTORE copy
          // streamed straight into the running target container. We do NOT use
          // the dump-to-file path here: redis-cli cannot move binary DUMP
          // payloads, and the --rdb/BGSAVE shortcut is blocked on Upstash and
          // most managed Redis, so we speak RESP directly (resp-client.ts).
          if (isRedisLike && isRedisUrl) {
            const running = await processManager.isRunning(containerName, {
              engine: engineName,
            })
            if (!running) {
              const msg = `Container "${containerName}" must be running to migrate from a connection string. Start it first.`
              if (options.json) {
                console.log(JSON.stringify({ error: msg }))
              } else {
                console.error(uiError(msg))
              }
              process.exit(1)
            }

            const source = parseRedisConnectionString(options.fromUrl)
            const engineEnum =
              engineName === 'valkey' ? Engine.Valkey : Engine.Redis
            const savedCreds = await loadCredentials(
              containerName,
              engineEnum,
              getDefaultUsername(engineEnum),
            )
            const targetDb =
              parseInt(options.database || config.database || '0', 10) || 0

            const copySpinner = createSpinner(
              'Copying keyspace from the remote database...',
            )
            copySpinner.start()
            // Hoisted out of the progress callback so a failure can say how
            // far the copy got. A migration that moved 40,000 keys and then
            // died is a different problem than one that moved none.
            let keysCopied = 0
            try {
              const copyResult = await copyRedisKeyspace(
                {
                  host: source.host,
                  port: source.port,
                  tls: source.tls,
                  username: source.username,
                  password: source.password,
                  database: source.database,
                },
                {
                  host: '127.0.0.1',
                  port: config.port,
                  tls: false,
                  username: savedCreds?.username,
                  password: savedCreds?.password,
                  database: targetDb,
                },
                {
                  onProgress: (p: RedisCopyProgress) => {
                    keysCopied = p.restored
                    copySpinner.text = `Copying keyspace... ${p.restored}/${p.total} keys`
                  },
                },
              )
              copySpinner.succeed(
                `Copied ${copyResult.keysCopied} keys from the remote ${engineName}`,
              )
              if (options.json) {
                console.log(
                  JSON.stringify({
                    success: true,
                    database: String(targetDb),
                    container: containerName,
                    engine: engineName,
                    format: 'redis-keyspace',
                    sourceType: 'connection-string',
                    keysCopied: copyResult.keysCopied,
                    overwritten: false,
                  }),
                )
              } else {
                console.log(
                  uiSuccess(
                    `Migrated ${copyResult.keysCopied} keys into "${containerName}"`,
                  ),
                )
              }
            } catch (error) {
              copySpinner.fail('Redis migration failed')
              // A rejected RESP call is not always an Error (a socket teardown
              // can reject with a plain object), and `(error as Error).message`
              // was then undefined - which JSON.stringify drops, so --json
              // printed a bare `{}`.
              const thrown = describeThrown(error)
              const msg = `Redis migration failed: ${thrown.message}`
              if (options.json) {
                console.log(
                  JSON.stringify({
                    error: msg,
                    ...(thrown.name ? { errorName: thrown.name } : {}),
                    ...(thrown.code ? { errorCode: thrown.code } : {}),
                    phase: 'redis-keyspace-copy',
                    keysCopied,
                  }),
                )
              } else {
                console.error(uiError(msg))
              }
              process.exit(1)
            }
            return
          }

          const timestamp = Date.now()
          tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}.dump`)

          let dumpSuccess = false
          let attempts = 0
          const maxAttempts = 2

          // Name the dump tool this engine actually runs. The label used to be
          // mysqldump for MySQL and pg_dump for everything else, so a MariaDB
          // restore whose mariadb-dump was missing reported a pg_dump failure
          // and offered to install PostgreSQL's client tools.
          const dumpTool = await getDumpToolName(engineName)

          while (!dumpSuccess && attempts < maxAttempts) {
            attempts++
            const dumpSpinner = createSpinner(
              'Creating dump from remote database...',
            )
            dumpSpinner.start()

            try {
              const dumpResult = await engine.dumpFromConnectionString(
                options.fromUrl,
                tempDumpPath,
                // Let the engine prefer a client tool that matches the
                // container being restored into when it keeps several
                // versions installed.
                { targetVersion: config.version },
              )
              dumpSpinner.succeed('Dump created from remote database')
              remoteSource = dumpResult.remoteSource
              if (dumpResult.warnings?.length && !options.json) {
                for (const warning of dumpResult.warnings) {
                  console.log(chalk.yellow(`  ${warning}`))
                }
              }
              backupPath = tempDumpPath
              dumpSuccess = true
            } catch (error) {
              const thrown = describeThrown(error)
              dumpSpinner.fail('Failed to create dump')

              if (
                thrown.message.includes(`${dumpTool} not found`) ||
                thrown.message.includes('ENOENT')
              ) {
                // No prompting in JSON mode - a script cannot answer it.
                if (options.json) {
                  console.log(
                    JSON.stringify({
                      error: `${dumpTool} not installed: ${thrown.message}`,
                      phase: 'remote-dump',
                      tool: dumpTool,
                    }),
                  )
                  process.exit(1)
                }
                const installed = await promptInstallDependencies(
                  dumpTool,
                  engineName,
                )
                if (!installed) {
                  process.exit(1)
                }
                continue
              }

              // This path printed NOTHING in --json mode, so a failed remote
              // dump exited 1 with empty stdout. It also split the label onto
              // stderr and the detail onto stdout, which no pipe keeps
              // together.
              if (options.json) {
                console.log(
                  JSON.stringify({
                    error: `${dumpTool} error: ${thrown.message}`,
                    ...(thrown.name ? { errorName: thrown.name } : {}),
                    ...(thrown.code ? { errorCode: thrown.code } : {}),
                    phase: 'remote-dump',
                    tool: dumpTool,
                  }),
                )
              } else {
                console.error()
                console.error(uiError(`${dumpTool} error:`))
                console.error(chalk.gray(`  ${thrown.message}`))
              }
              process.exit(1)
            }
          }

          if (!dumpSuccess) {
            const msg = 'Failed to create dump after retries'
            if (options.json) {
              console.log(
                JSON.stringify({
                  error: msg,
                  phase: 'remote-dump',
                  tool: dumpTool,
                }),
              )
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }
        } else {
          if (!backupPath) {
            const msg = 'Backup file path is required'
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
              console.log(
                chalk.gray('  Usage: spindb restore <container> <backup-file>'),
              )
              console.log(
                chalk.gray(
                  '     or: spindb restore <container> --from-url <connection-string>',
                ),
              )
            }
            process.exit(1)
          }

          if (!existsSync(backupPath)) {
            const msg = `Backup file not found: ${backupPath}`
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }
        }

        let databaseName = options.database
        if (!databaseName) {
          // File-based engines (SQLite, DuckDB) don't have separate databases
          // The file IS the database, so use the container name
          if (isFileBasedEngine(engineName)) {
            databaseName = containerName
          } else {
            databaseName = await promptDatabaseName(containerName, engineName)
          }
        }

        if (!backupPath) {
          const msg = 'No backup path specified'
          if (options.json) {
            console.log(JSON.stringify({ error: msg }))
          } else {
            console.error(uiError(msg))
          }
          process.exit(1)
        }

        const detectSpinner = createSpinner('Detecting backup format...')
        detectSpinner.start()

        const format = await engine.detectBackupFormat(backupPath)
        detectSpinner.succeed(`Detected: ${format.description}`)

        // For Redis/Valkey, check running state based on format
        // - Text format (.redis/.valkey) requires container to be RUNNING
        // - RDB format requires container to be STOPPED
        if (isRedisLike) {
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          const isRdbFormat = format.format === 'rdb'

          if (isRdbFormat && running) {
            const msg = `Container "${containerName}" must be stopped for RDB restore. Run: spindb stop ${containerName}`
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }

          if (!isRdbFormat && !running) {
            const msg = `Container "${containerName}" is not running. Start it first for text format restore.`
            if (options.json) {
              console.log(JSON.stringify({ error: msg }))
            } else {
              console.error(uiError(msg))
            }
            process.exit(1)
          }
        }

        // Check if database already exists
        const databaseExists =
          config.databases && config.databases.includes(databaseName)

        // --into-existing requires the database to already exist - it never
        // creates one (that is the destructive path's job) and it never drops
        // it. Fail clearly rather than silently doing nothing.
        if (options.intoExisting && !databaseExists) {
          const msg = `Database "${databaseName}" does not exist. Restore without --into-existing to create it.`
          if (options.json) {
            console.log(JSON.stringify({ error: msg }))
          } else {
            console.log(chalk.red(`\n  ${msg}\n`))
          }
          process.exit(1)
        }

        // The drop+recreate path is destructive; --into-existing skips it
        // entirely and restores into the live database in place.
        if (databaseExists && !options.intoExisting) {
          if (!options.force) {
            // In JSON mode, just error out - no interactive prompts
            if (options.json) {
              console.log(
                JSON.stringify({
                  error: `Database "${databaseName}" already exists. Use --force to overwrite.`,
                }),
              )
              process.exit(1)
            }

            // Interactive mode - prompt for confirmation
            console.log()
            console.log(
              chalk.yellow(
                `  Warning: Database "${databaseName}" already exists.`,
              ),
            )
            console.log(
              chalk.gray(
                '  This operation will drop and recreate the database.',
              ),
            )
            console.log()

            const confirmed = await promptConfirm(
              'Do you want to overwrite the existing database?',
              false,
            )

            if (!confirmed) {
              console.log(chalk.gray('\n  Restore cancelled\n'))
              return
            }
          }

          // Drop existing database (tracking entry stays - we're recreating same name)
          const dropSpinner = createSpinner(
            `Dropping existing database "${databaseName}"...`,
          )
          dropSpinner.start()

          try {
            await engine.dropDatabase(config, databaseName)
            // Don't remove from tracking - the database name stays the same
            // and addDatabase() is idempotent, so tracking remains valid
            dropSpinner.succeed(`Dropped database "${databaseName}"`)
          } catch (dropErr) {
            dropSpinner.fail('Failed to drop database')
            throw dropErr
          }
        }

        // Use TransactionManager to ensure database is cleaned up on restore failure
        const tx = new TransactionManager()
        let databaseCreated = false

        // Some engines (TypeDB) create the database as part of their restore
        // (`database import`), so we must NOT pre-create it here.
        const createsOnRestore =
          !options.intoExisting && restoreCreatesDatabase(engineName)
        const dbSpinner = createSpinner(
          options.intoExisting
            ? `Preparing existing database "${databaseName}"...`
            : createsOnRestore
              ? `Preparing database "${databaseName}"...`
              : `Creating database "${databaseName}"...`,
        )
        dbSpinner.start()

        try {
          if (!options.intoExisting) {
            // TypeDB's restore (`database import`) creates the database itself,
            // so pre-creating it here makes the import fail "already exists". For
            // those engines, skip createDatabase - the DROP above already cleared
            // any existing database, and the engine restore creates it fresh.
            if (!restoreCreatesDatabase(engineName)) {
              await engine.createDatabase(config, databaseName)
            }
            // databaseCreated is true for BOTH paths: this restore owns the
            // database's creation - either createDatabase above, or (for
            // restoreCreatesDatabase engines) the engine's own `database import`
            // below. Any PRE-EXISTING database was already dropped by the
            // drop+recreate step above, so on failure the rollback can only ever
            // drop what THIS restore created, never the caller's prior data. For
            // restoreCreatesDatabase engines the flag must stay true so a
            // partially-imported database is still cleaned up on failure.
            databaseCreated = true
            dbSpinner.succeed(`Database "${databaseName}" ready`)

            // File-based engines (SQLite, DuckDB) don't need database tracking
            // They use a registry and the file IS the database
            if (!isFileBasedEngine(engineName)) {
              // Register rollback to drop database if restore fails
              tx.addRollback({
                description: `Drop database "${databaseName}"`,
                execute: async () => {
                  try {
                    await engine.dropDatabase(config, databaseName)
                    logDebug(`Rolled back: dropped database "${databaseName}"`)
                  } catch (dropErr) {
                    logDebug(
                      `Failed to drop database during rollback: ${dropErr instanceof Error ? dropErr.message : String(dropErr)}`,
                    )
                  }
                },
              })

              await containerManager.addDatabase(containerName, databaseName)

              // Register rollback to remove database from container tracking
              tx.addRollback({
                description: `Remove "${databaseName}" from container tracking`,
                execute: async () => {
                  try {
                    await containerManager.removeDatabase(
                      containerName,
                      databaseName,
                    )
                    logDebug(
                      `Rolled back: removed "${databaseName}" from container tracking`,
                    )
                  } catch (removeErr) {
                    logDebug(
                      `Failed to remove database from tracking during rollback: ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
                    )
                  }
                },
              })
            }
          } else {
            // --into-existing: the database already exists and is deliberately
            // NEITHER dropped NOR recreated, and NO drop-on-failure rollback is
            // registered - we must never drop the caller's existing data. The
            // engine restore replaces the contents in place (e.g. pg_restore
            // --clean --if-exists drops + recreates each object), which is safe
            // while live connections (a pooler, a health monitor) stay open.
            dbSpinner.succeed(
              `Restoring into existing database "${databaseName}"`,
            )
          }

          // --pre-sql: compatibility shims the dump needs and the target does
          // not have (a missing extension, the roles a dump grants to, a
          // function a column default calls). It runs AFTER the database
          // exists and BEFORE the restore, inside the same transaction scope,
          // so a shim that fails takes the created database down with it
          // rather than leaving a half-prepared one behind. With
          // --into-existing there is no created database and no rollback, so a
          // failed shim just aborts before anything is restored.
          if (options.preSql) {
            const preSqlSpinner = createSpinner(
              `Applying pre-restore SQL from ${options.preSql}...`,
            )
            preSqlSpinner.start()
            try {
              await engine.runScript(config, {
                file: options.preSql,
                database: databaseName,
                // Keep psql/mysql chatter off stdout: --json owns it.
                quiet: true,
              })
              preSqlApplied = true
              preSqlSpinner.succeed('Pre-restore SQL applied')
            } catch (preSqlErr) {
              preSqlSpinner.fail('Pre-restore SQL failed')
              const thrown = describeThrown(preSqlErr)
              throw new Error(
                `--pre-sql failed (${options.preSql}): ${thrown.message}`,
              )
            }
          }

          const restoreSpinner = createSpinner('Restoring backup...')
          restoreSpinner.start()

          const result = await engine.restore(config, backupPath, {
            database: databaseName,
            createDatabase: false,
            // Object-level clean so an in-place restore is a faithful REPLACE
            // (not a merge into the existing contents).
            ...(options.intoExisting ? { clean: true } : {}),
            ...(options.withPrivileges ? { withPrivileges: true } : {}),
          })

          // What the restore tool actually did. The old rule here failed only
          // on a literal FATAL in stderr, so a pg_restore that could not create
          // a single table (missing extension -> failed defaults -> skipped
          // COPY) reported success and exited 0.
          outcome = classifyRestoreOutcome(result)

          if (outcome.failed) {
            restoreSpinner.fail('Restore failed')
            throw new Error(restoreFailureMessage(result))
          }

          if (outcome.hadObjectErrors) {
            restoreSpinner.warn(outcome.summary)
            // STDOUT belongs to --json. This block used to write to it
            // unconditionally, which made the JSON unparseable exactly when
            // something had gone wrong.
            if (!options.json) {
              console.log(chalk.yellow('\n  Objects that failed to restore:'))
              for (const line of restoreErrorReportLines(
                outcome.diagnostics,
                10,
              )) {
                console.log(chalk.gray(`    ${line}`))
              }
              console.log(
                chalk.gray(
                  '\n  The database was created and holds what could be restored.',
                ),
              )
              console.log(
                chalk.gray(
                  '  Re-run with --pre-sql <file> to create the missing extensions/roles first.',
                ),
              )
            }
          } else {
            restoreSpinner.succeed(outcome.summary)
          }

          // Restore succeeded - commit transaction (clear rollback actions)
          tx.commit()
        } catch (restoreErr) {
          // Restore failed - execute rollbacks to clean up created database
          if (databaseCreated) {
            console.log(chalk.yellow('\n  Cleaning up after failed restore...'))
            await tx.rollback()
          }
          throw restoreErr
        }

        const connectionString = engine.getConnectionString(
          config,
          databaseName,
        )

        if (options.json) {
          const metadata = await getEngineMetadata(engineName)
          console.log(
            JSON.stringify({
              // success + exit 0 still mean "the restore ran and the database
              // is usable". `status` is what says whether everything in the
              // dump made it: additive on purpose, so existing consumers
              // (layerbase-desktop, layerbase-cloud) keep working unchanged.
              success: true,
              status: outcome?.status ?? 'completed',
              database: databaseName,
              container: containerName,
              engine: engineName,
              format: format.description,
              sourceType: options.fromUrl ? 'remote' : 'file',
              ...(remoteSource ? { remoteSource } : {}),
              ...(preSqlApplied ? { preSqlApplied: true } : {}),
              ...(options.withPrivileges ? { privilegesRestored: true } : {}),
              ...(outcome ? restoreDiagnosticsJson(outcome) : {}),
              connectionString,
              overwritten: databaseExists,
              ...metadata,
            }),
          )
        } else {
          console.log()
          console.log(uiSuccess(`Database "${databaseName}" restored`))
          console.log()
          console.log(chalk.gray('  Connection string:'))
          console.log(chalk.cyan(`  ${connectionString}`))

          const copied = await platformService.copyToClipboard(connectionString)
          if (copied) {
            console.log(chalk.gray('  Connection string copied to clipboard'))
          } else {
            console.log(chalk.gray('  (Could not copy to clipboard)'))
          }

          console.log()
          console.log(chalk.gray('  Connect with:'))
          console.log(
            chalk.cyan(`  spindb connect ${containerName} -d ${databaseName}`),
          )
          console.log()
        }
      } catch (error) {
        const thrown = describeThrown(error)

        const missingToolPatterns = [
          'pg_restore not found',
          'psql not found',
          'pg_dump not found',
          'mysql not found',
          'mysqldump not found',
        ]

        const matchingPattern = missingToolPatterns.find((p) =>
          thrown.message.includes(p),
        )

        if (matchingPattern) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error: thrown.message,
                ...(thrown.name ? { errorName: thrown.name } : {}),
                ...(thrown.code ? { errorCode: thrown.code } : {}),
              }),
            )
            process.exit(1)
          }
          const missingTool = matchingPattern.replace(' not found', '')
          const installed = await promptInstallDependencies(missingTool)
          if (installed) {
            console.log(
              chalk.yellow('  Please re-run your command to continue.'),
            )
          }
          process.exit(1)
        }

        if (options.json) {
          console.log(
            JSON.stringify({
              error: thrown.message,
              ...(thrown.name ? { errorName: thrown.name } : {}),
              ...(thrown.code ? { errorCode: thrown.code } : {}),
              ...(outcome?.hadObjectErrors
                ? restoreDiagnosticsJson(outcome)
                : {}),
            }),
          )
        } else {
          console.error(uiError(thrown.message))
        }
        process.exit(1)
      } finally {
        if (tempDumpPath) {
          try {
            await rm(tempDumpPath, { force: true })
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    },
  )
