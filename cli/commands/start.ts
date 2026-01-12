import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { startWithRetry } from '../../core/start-with-retry'
import { getEngine } from '../../engines'
import { getEngineDefaults } from '../../config/defaults'
import { promptContainerSelect, promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiError, uiWarning } from '../ui/theme'
import { Engine } from '../../types'

export const startCommand = new Command('start')
  .description('Start a container')
  .argument('[name]', 'Container name')
  .option('-j, --json', 'Output result as JSON')
  .action(async (name: string | undefined, options: { json?: boolean }) => {
    try {
      let containerName = name

      if (!containerName) {
        const containers = await containerManager.list()
        const stopped = containers.filter((c) => c.status !== 'running')

        if (stopped.length === 0) {
          if (containers.length === 0) {
            console.log(
              uiWarning('No containers found. Create one with: spindb create'),
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
        console.error(uiError(`Container "${containerName}" not found`))
        process.exit(1)
      }

      const { engine: engineName } = config

      const running = await processManager.isRunning(containerName, {
        engine: engineName,
      })
      if (running) {
        console.log(
          uiWarning(`Container "${containerName}" is already running`),
        )
        return
      }

      const engineDefaults = getEngineDefaults(engineName)
      const engine = getEngine(engineName)

      // For PostgreSQL, check if the engine binary is installed
      if (engineName === Engine.PostgreSQL) {
        const isInstalled = await engine.isBinaryInstalled(config.version)
        if (!isInstalled) {
          console.log(
            uiWarning(
              `PostgreSQL ${config.version} engine is not installed (required by "${containerName}")`,
            ),
          )
          const confirmed = await promptConfirm(
            `Download PostgreSQL ${config.version} now?`,
            true,
          )
          if (!confirmed) {
            console.log(
              chalk.gray(
                `  Run "spindb engines download postgresql ${config.version}" to download manually.`,
              ),
            )
            return
          }

          const downloadSpinner = createSpinner(
            `Downloading PostgreSQL ${config.version}...`,
          )
          downloadSpinner.start()

          try {
            await engine.ensureBinaries(
              config.version,
              ({ stage, message }) => {
                if (stage === 'cached') {
                  downloadSpinner.text = `PostgreSQL ${config.version} ready`
                } else {
                  downloadSpinner.text = message
                }
              },
            )
            downloadSpinner.succeed(`PostgreSQL ${config.version} downloaded`)
          } catch (downloadError) {
            downloadSpinner.fail(
              `Failed to download PostgreSQL ${config.version} for "${containerName}"`,
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
        if (result.error) {
          console.error(uiError(result.error.message))
        }
        process.exit(1)
      }

      await containerManager.updateConfig(containerName, { status: 'running' })

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

      const connectionString = engine.getConnectionString(config)

      if (options.json) {
        console.log(
          JSON.stringify({
            success: true,
            name: containerName,
            engine: config.engine,
            port: result.finalPort,
            connectionString,
            portChanged: result.retriesUsed > 0,
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
      console.error(uiError(e.message))
      process.exit(1)
    }
  })
