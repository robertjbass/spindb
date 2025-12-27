import { Command } from 'commander'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptContainerSelect, promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiError, uiWarning } from '../ui/theme'

export const deleteCommand = new Command('delete')
  .alias('rm')
  .description('Delete a container')
  .argument('[name]', 'Container name')
  .option('-f, --force', 'Force delete (stop if running)')
  .option('-y, --yes', 'Skip confirmation')
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (
      name: string | undefined,
      options: { force?: boolean; yes?: boolean; json?: boolean },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(uiWarning('No containers found'))
            return
          }

          const selected = await promptContainerSelect(
            containers,
            'Select container to delete:',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(uiError(`Container "${containerName}" not found`))
          process.exit(1)
        }

        if (!options.yes) {
          const confirmed = await promptConfirm(
            `Are you sure you want to delete "${containerName}"? This cannot be undone.`,
            false,
          )
          if (!confirmed) {
            console.log(uiWarning('Deletion cancelled'))
            return
          }
        }

        const running = await processManager.isRunning(containerName, {
          engine: config.engine,
        })
        if (running) {
          if (options.force) {
            const stopSpinner = createSpinner(`Stopping ${containerName}...`)
            stopSpinner.start()

            const engine = getEngine(config.engine)
            await engine.stop(config)

            stopSpinner.succeed(`Stopped "${containerName}"`)
          } else {
            console.error(
              uiError(
                `Container "${containerName}" is running. Stop it first or use --force`,
              ),
            )
            process.exit(1)
          }
        }

        const deleteSpinner = createSpinner(`Deleting ${containerName}...`)
        deleteSpinner.start()

        await containerManager.delete(containerName, { force: true })

        deleteSpinner.succeed(`Container "${containerName}" deleted`)

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              deleted: containerName,
              container: containerName,
              engine: config.engine,
            }),
          )
        }
      } catch (error) {
        const e = error as Error
        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
