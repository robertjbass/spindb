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
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { success, error, warning } from '../ui/theme'
import { tmpdir } from 'os'
import { join } from 'path'
import { getMissingDependencies } from '../../core/dependency-manager'
import { platformService } from '../../core/platform-service'
import { TransactionManager } from '../../core/transaction-manager'
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
  .action(
    async (
      name: string | undefined,
      backup: string | undefined,
      options: { database?: string; fromUrl?: string },
    ) => {
      let tempDumpPath: string | null = null

      try {
        let containerName = name
        let backupPath = backup

        if (!containerName) {
          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            if (containers.length === 0) {
              console.log(
                warning('No containers found. Create one with: spindb create'),
              )
            } else {
              console.log(
                warning(
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
          console.error(error(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const { engine: engineName } = config

        const running = await processManager.isRunning(containerName, {
          engine: engineName,
        })
        if (!running) {
          console.error(
            error(
              `Container "${containerName}" is not running. Start it first.`,
            ),
          )
          process.exit(1)
        }

        const engine = getEngine(engineName)

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
              error(
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
              error(
                'Connection string must start with postgresql:// or postgres:// for PostgreSQL containers',
              ),
            )
            process.exit(1)
          }

          if (engineName === 'mysql' && !isMysqlUrl) {
            console.error(
              error(
                'Connection string must start with mysql:// for MySQL containers',
              ),
            )
            process.exit(1)
          }

          if (!isPgUrl && !isMysqlUrl) {
            console.error(
              error(
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
              await engine.dumpFromConnectionString(
                options.fromUrl,
                tempDumpPath,
              )
              dumpSpinner.succeed('Dump created from remote database')
              backupPath = tempDumpPath
              dumpSuccess = true
            } catch (err) {
              const e = err as Error
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
              console.error(error(`${dumpTool} error:`))
              console.log(chalk.gray(`  ${e.message}`))
              process.exit(1)
            }
          }

          if (!dumpSuccess) {
            console.error(error('Failed to create dump after retries'))
            process.exit(1)
          }
        } else {
          if (!backupPath) {
            console.error(error('Backup file path is required'))
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
            console.error(error(`Backup file not found: ${backupPath}`))
            process.exit(1)
          }
        }

        let databaseName = options.database
        if (!databaseName) {
          databaseName = await promptDatabaseName(containerName, engineName)
        }

        if (!backupPath) {
          console.error(error('No backup path specified'))
          process.exit(1)
        }

        const detectSpinner = createSpinner('Detecting backup format...')
        detectSpinner.start()

        const format = await engine.detectBackupFormat(backupPath)
        detectSpinner.succeed(`Detected: ${format.description}`)

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

          if (result.code === 0 || !result.stderr) {
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
        console.log()
        console.log(success(`Database "${databaseName}" restored`))
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
      } catch (err) {
        const e = err as Error

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
          const missingTool = matchingPattern.replace(' not found', '')
          const installed = await promptInstallDependencies(missingTool)
          if (installed) {
            console.log(
              chalk.yellow('  Please re-run your command to continue.'),
            )
          }
          process.exit(1)
        }

        console.error(error(e.message))
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
