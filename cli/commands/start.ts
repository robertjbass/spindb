import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { startWithRetry } from '../../core/start-with-retry'
import { getEngine } from '../../engines'
import { getEngineDefaults } from '../../config/defaults'
import { promptContainerSelect } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { error, warning } from '../ui/theme'

export const startCommand = new Command('start')
  .description('Start a container')
  .argument('[name]', 'Container name')
  .action(async (name: string | undefined) => {
    try {
      let containerName = name

      if (!containerName) {
        const containers = await containerManager.list()
        const stopped = containers.filter((c) => c.status !== 'running')

        if (stopped.length === 0) {
          if (containers.length === 0) {
            console.log(
              warning('No containers found. Create one with: spindb create'),
            )
          } else {
            console.log(warning('All containers are already running'))
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
        console.error(error(`Container "${containerName}" not found`))
        process.exit(1)
      }

      const { engine: engineName } = config

      const running = await processManager.isRunning(containerName, {
        engine: engineName,
      })
      if (running) {
        console.log(warning(`Container "${containerName}" is already running`))
        return
      }

      const engineDefaults = getEngineDefaults(engineName)
      const engine = getEngine(engineName)

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
          console.error(error(result.error.message))
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
      console.log()
      console.log(chalk.gray('  Connection string:'))
      console.log(chalk.cyan(`  ${connectionString}`))
      console.log()
      console.log(chalk.gray('  Connect with:'))
      console.log(chalk.cyan(`  spindb connect ${containerName}`))
      console.log()
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })
