import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '@/core/container-manager'
import { processManager } from '@/core/process-manager'
import { getEngine } from '@/engines'
import { promptContainerSelect, promptContainerName } from '@/cli/ui/prompts'
import { createSpinner } from '@/cli/ui/spinner'
import { error, warning, connectionBox } from '@/cli/ui/theme'

export const cloneCommand = new Command('clone')
  .description('Clone a container with all its data')
  .argument('[source]', 'Source container name')
  .argument('[target]', 'Target container name')
  .action(async (source: string | undefined, target: string | undefined) => {
    try {
      let sourceName = source
      let targetName = target

      // Interactive selection if no source provided
      if (!sourceName) {
        const containers = await containerManager.list()
        const stopped = containers.filter((c) => c.status !== 'running')

        if (containers.length === 0) {
          console.log(
            warning('No containers found. Create one with: spindb create'),
          )
          return
        }

        if (stopped.length === 0) {
          console.log(
            warning(
              'All containers are running. Stop a container first to clone it.',
            ),
          )
          console.log(
            chalk.gray(
              '  Cloning requires the source container to be stopped.',
            ),
          )
          return
        }

        const selected = await promptContainerSelect(
          stopped,
          'Select container to clone:',
        )
        if (!selected) return
        sourceName = selected
      }

      // Check source exists
      const sourceConfig = await containerManager.getConfig(sourceName)
      if (!sourceConfig) {
        console.error(error(`Container "${sourceName}" not found`))
        process.exit(1)
      }

      // Check source is stopped
      const running = await processManager.isRunning(sourceName)
      if (running) {
        console.error(
          error(
            `Container "${sourceName}" is running. Stop it first to clone.`,
          ),
        )
        process.exit(1)
      }

      // Get target name
      if (!targetName) {
        targetName = await promptContainerName(`${sourceName}-copy`)
      }

      // Clone the container
      const cloneSpinner = createSpinner(
        `Cloning ${sourceName} to ${targetName}...`,
      )
      cloneSpinner.start()

      const newConfig = await containerManager.clone(sourceName, targetName)

      cloneSpinner.succeed(`Cloned "${sourceName}" to "${targetName}"`)

      // Get engine for connection string
      const engine = getEngine(newConfig.engine)
      const connectionString = engine.getConnectionString(newConfig)

      console.log()
      console.log(connectionBox(targetName, connectionString, newConfig.port))
      console.log()
      console.log(chalk.gray('  Start the cloned container:'))
      console.log(chalk.cyan(`  spindb start ${targetName}`))
      console.log()
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })
