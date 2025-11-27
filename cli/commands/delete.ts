import { Command } from 'commander'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptContainerSelect, promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { error, warning } from '../ui/theme'

export const deleteCommand = new Command('delete')
  .alias('rm')
  .description('Delete a container')
  .argument('[name]', 'Container name')
  .option('-f, --force', 'Force delete (stop if running)')
  .option('-y, --yes', 'Skip confirmation')
  .action(
    async (
      name: string | undefined,
      options: { force?: boolean; yes?: boolean },
    ) => {
      try {
        let containerName = name

        // Interactive selection if no name provided
        if (!containerName) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(warning('No containers found'))
            return
          }

          const selected = await promptContainerSelect(
            containers,
            'Select container to delete:',
          )
          if (!selected) return
          containerName = selected
        }

        // Get container config
        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(error(`Container "${containerName}" not found`))
          process.exit(1)
        }

        // Confirm deletion
        if (!options.yes) {
          const confirmed = await promptConfirm(
            `Are you sure you want to delete "${containerName}"? This cannot be undone.`,
            false,
          )
          if (!confirmed) {
            console.log(warning('Deletion cancelled'))
            return
          }
        }

        // Check if running
        const running = await processManager.isRunning(containerName, {
          engine: config.engine,
        })
        if (running) {
          if (options.force) {
            // Stop the container first
            const stopSpinner = createSpinner(`Stopping ${containerName}...`)
            stopSpinner.start()

            const engine = getEngine(config.engine)
            await engine.stop(config)

            stopSpinner.succeed(`Stopped "${containerName}"`)
          } else {
            console.error(
              error(
                `Container "${containerName}" is running. Stop it first or use --force`,
              ),
            )
            process.exit(1)
          }
        }

        // Delete the container
        const deleteSpinner = createSpinner(`Deleting ${containerName}...`)
        deleteSpinner.start()

        await containerManager.delete(containerName, { force: true })

        deleteSpinner.succeed(`Container "${containerName}" deleted`)
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
