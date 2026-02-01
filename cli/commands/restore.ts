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
import { platformService } from '../../core/platform-service'
import { TransactionManager } from '../../core/transaction-manager'
import { isFileBasedEngine } from '../../types'
import { logDebug } from '../../core/error-handler'

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
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (
      name: string | undefined,
      backup: string | undefined,
      options: {
        database?: string
        fromUrl?: string
        force?: boolean
        json?: boolean
      },
    ) => {
      let tempDumpPath: string | null = null

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

        const { engine: engineName } = config
        const engine = getEngine(engineName)

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

          if (engineName === 'postgresql' && !isPgUrl) {
            console.error(
              uiError(
                'Connection string must start with postgresql:// or postgres:// for PostgreSQL containers',
              ),
            )
            process.exit(1)
          }

          if (engineName === 'mysql' && !isMysqlUrl) {
            console.error(
              uiError(
                'Connection string must start with mysql:// for MySQL containers',
              ),
            )
            process.exit(1)
          }

          if (!isPgUrl && !isMysqlUrl) {
            console.error(
              uiError(
                'Connection string must start with postgresql://, postgres://, or mysql://',
              ),
            )
            process.exit(1)
          }

          const timestamp = Date.now()
          tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}.dump`)

          let dumpSuccess = false
          let attempts = 0
          const maxAttempts = 2

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
              )
              dumpSpinner.succeed('Dump created from remote database')
              if (dumpResult.warnings?.length) {
                for (const warning of dumpResult.warnings) {
                  console.log(chalk.yellow(`  ${warning}`))
                }
              }
              backupPath = tempDumpPath
              dumpSuccess = true
            } catch (error) {
              const e = error as Error
              dumpSpinner.fail('Failed to create dump')

              const dumpTool = engineName === 'mysql' ? 'mysqldump' : 'pg_dump'
              if (
                e.message.includes(`${dumpTool} not found`) ||
                e.message.includes('ENOENT')
              ) {
                const installed = await promptInstallDependencies(
                  dumpTool,
                  engineName,
                )
                if (!installed) {
                  process.exit(1)
                }
                continue
              }

              console.log()
              console.error(uiError(`${dumpTool} error:`))
              console.log(chalk.gray(`  ${e.message}`))
              process.exit(1)
            }
          }

          if (!dumpSuccess) {
            console.error(uiError('Failed to create dump after retries'))
            process.exit(1)
          }
        } else {
          if (!backupPath) {
            console.error(uiError('Backup file path is required'))
            console.log(
              chalk.gray('  Usage: spindb restore <container> <backup-file>'),
            )
            console.log(
              chalk.gray(
                '     or: spindb restore <container> --from-url <connection-string>',
              ),
            )
            process.exit(1)
          }

          if (!existsSync(backupPath)) {
            console.error(uiError(`Backup file not found: ${backupPath}`))
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
          console.error(uiError('No backup path specified'))
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
            console.error(
              uiError(
                `Container "${containerName}" must be stopped for RDB restore. Run: spindb stop ${containerName}`,
              ),
            )
            process.exit(1)
          }

          if (!isRdbFormat && !running) {
            console.error(
              uiError(
                `Container "${containerName}" is not running. Start it first for text format restore.`,
              ),
            )
            process.exit(1)
          }
        }

        // Check if database already exists
        const databaseExists =
          config.databases && config.databases.includes(databaseName)

        if (databaseExists) {
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

        const dbSpinner = createSpinner(
          `Creating database "${databaseName}"...`,
        )
        dbSpinner.start()

        try {
          await engine.createDatabase(config, databaseName)
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

          const restoreSpinner = createSpinner('Restoring backup...')
          restoreSpinner.start()

          const result = await engine.restore(config, backupPath, {
            database: databaseName,
            createDatabase: false,
          })

          // Check if restore completely failed (non-zero code with no data restored)
          if (result.code !== 0 && result.stderr?.includes('FATAL')) {
            restoreSpinner.fail('Restore failed')
            throw new Error(result.stderr || 'Restore failed with fatal error')
          }

          if (result.code === 0) {
            restoreSpinner.succeed('Backup restored successfully')
          } else {
            // pg_restore often returns warnings even on success
            restoreSpinner.warn('Restore completed with warnings')
            if (result.stderr) {
              console.log(chalk.yellow('\n  Warnings:'))
              const lines = result.stderr.split('\n').slice(0, 5)
              lines.forEach((line) => {
                if (line.trim()) {
                  console.log(chalk.gray(`    ${line}`))
                }
              })
              if (result.stderr.split('\n').length > 5) {
                console.log(chalk.gray('    ...'))
              }
            }
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
          console.log(
            JSON.stringify({
              success: true,
              database: databaseName,
              container: containerName,
              engine: engineName,
              format: format.description,
              sourceType: options.fromUrl ? 'remote' : 'file',
              connectionString,
              overwritten: databaseExists,
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
        const e = error as Error

        const missingToolPatterns = [
          'pg_restore not found',
          'psql not found',
          'pg_dump not found',
          'mysql not found',
          'mysqldump not found',
        ]

        const matchingPattern = missingToolPatterns.find((p) =>
          e.message.includes(p),
        )

        if (matchingPattern) {
          if (options.json) {
            console.log(JSON.stringify({ error: e.message }))
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
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
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
