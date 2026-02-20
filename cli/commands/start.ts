import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { startWithRetry } from '../../core/start-with-retry'
import { getEngine } from '../../engines'
import { postgresqlEngine } from '../../engines/postgresql'
import { getEngineDefaults } from '../../config/defaults'
import { promptContainerSelect, promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiWarning } from '../ui/theme'
import { Engine, isFileBasedEngine } from '../../types'
import { exitWithError, logDebug } from '../../core/error-handler'
import { getEngineMetadata } from '../helpers'

export const startCommand = new Command('start')
  .description('Start a container')
  .argument('[name]', 'Container name')
  .option('-j, --json', 'Output result as JSON')
  .option('-f, --force', 'Skip confirmation prompts (e.g., binary downloads)')
  .action(
    async (
      name: string | undefined,
      options: { json?: boolean; force?: boolean },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          // JSON mode requires container name argument
          if (options.json) {
            return exitWithError({
              message: 'Container name is required',
              json: true,
            })
          }

          const containers = await containerManager.list()
          const stopped = containers.filter((c) => c.status !== 'running')

          if (stopped.length === 0) {
            if (containers.length === 0) {
              console.log(
                uiWarning(
                  'No containers found. Create one with: spindb create',
                ),
              )
            } else {
              console.log(uiWarning('All containers are already running'))
            }
            return
          }

          const selected = await promptContainerSelect(
            stopped,
            'Select container to start:',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          return exitWithError({
            message: `Container "${containerName}" not found`,
            json: options.json,
          })
        }

        const { engine: engineName } = config

        const running = await processManager.isRunning(containerName, {
          engine: engineName,
        })
        if (running) {
          if (options.json) {
            return exitWithError({
              message: `Container "${containerName}" is already running`,
              json: true,
            })
          }
          console.log(
            uiWarning(`Container "${containerName}" is already running`),
          )
          return
        }

        const engineDefaults = getEngineDefaults(engineName)
        const engine = getEngine(engineName)

        // For PostgreSQL, check if compatible binaries are available
        // Self-healing logic in engine.start() will handle version resolution
        if (engineName === Engine.PostgreSQL) {
          const hasCompatible = postgresqlEngine.hasCompatibleBinaries(
            config.version,
          )
          if (!hasCompatible) {
            // No compatible binaries found - get the current supported version for this major
            const majorVersion = config.version.split('.')[0]
            console.log(
              uiWarning(
                `No PostgreSQL ${majorVersion}.x binaries found (required by "${containerName}")`,
              ),
            )
            const confirmed =
              options.force ||
              (await promptConfirm(
                `Download PostgreSQL ${majorVersion} now?`,
                true,
              ))
            if (!confirmed) {
              console.log(
                chalk.gray(
                  `  Run "spindb engines download postgresql ${majorVersion}" to download manually.`,
                ),
              )
              return
            }

            const downloadSpinner = createSpinner(
              `Downloading PostgreSQL ${majorVersion}...`,
            )
            downloadSpinner.start()

            try {
              await engine.ensureBinaries(
                majorVersion,
                ({ stage, message }) => {
                  if (stage === 'cached') {
                    downloadSpinner.text = `PostgreSQL ${majorVersion} ready`
                  } else {
                    downloadSpinner.text = message
                  }
                },
              )
              downloadSpinner.succeed(`PostgreSQL ${majorVersion} downloaded`)
            } catch (downloadError) {
              downloadSpinner.fail(
                `Failed to download PostgreSQL ${majorVersion} for "${containerName}"`,
              )
              throw downloadError
            }
          }
        }

        const spinner = createSpinner(`Starting ${containerName}...`)
        spinner.start()

        const result = await startWithRetry({
          engine,
          config,
          onPortChange: (oldPort, newPort) => {
            spinner.text = `Port ${oldPort} was in use, retrying with port ${newPort}...`
          },
        })

        if (!result.success) {
          spinner.fail(`Failed to start "${containerName}"`)
          return exitWithError({
            message: result.error?.message || 'Unknown error',
            json: options.json,
          })
        }

        await containerManager.updateConfig(containerName, {
          status: 'running',
        })

        if (result.retriesUsed > 0) {
          spinner.warn(
            `Container "${containerName}" started on port ${result.finalPort} (original port was in use)`,
          )
        } else {
          spinner.succeed(`Container "${containerName}" started`)
        }

        // Database might already exist, which is fine
        const defaultDb = engineDefaults.superuser
        if (config.database && config.database !== defaultDb) {
          const dbSpinner = createSpinner(
            `Ensuring database "${config.database}" exists...`,
          )
          dbSpinner.start()
          try {
            await engine.createDatabase(config, config.database)
            dbSpinner.succeed(`Database "${config.database}" ready`)
          } catch {
            dbSpinner.succeed(`Database "${config.database}" ready`)
          }
        }

        // Sync database registry with actual server state (silent, non-blocking)
        if (!isFileBasedEngine(config.engine)) {
          try {
            await containerManager.syncDatabases(containerName)
          } catch (syncError) {
            // Don't fail start if sync fails - just log for debugging
            logDebug(
              `Failed to sync databases for ${containerName}: ${syncError}`,
            )
          }
        }

        const connectionString = engine.getConnectionString(config)

        if (options.json) {
          const metadata = await getEngineMetadata(config.engine)
          console.log(
            JSON.stringify({
              success: true,
              name: containerName,
              engine: config.engine,
              port: result.finalPort,
              connectionString,
              portChanged: result.retriesUsed > 0,
              ...metadata,
            }),
          )
        } else {
          console.log()
          console.log(chalk.gray('  Connection string:'))
          console.log(chalk.cyan(`  ${connectionString}`))
          console.log()
          console.log(chalk.gray('  Connect with:'))
          console.log(chalk.cyan(`  spindb connect ${containerName}`))
          console.log()
        }
      } catch (error) {
        const e = error as Error
        return exitWithError({ message: e.message, json: options.json })
      }
    },
  )
