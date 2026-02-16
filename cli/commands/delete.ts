import { Command } from 'commander'
import { containerManager } from '../../core/container-manager'
import { exitWithError, isInteractiveMode } from '../../core/error-handler'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptContainerSelect, promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiWarning } from '../ui/theme'
import { getEngineMetadata } from '../helpers'

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
          // JSON mode requires container name argument
          if (options.json) {
            return exitWithError({
              message: 'Container name is required',
              json: true,
            })
          }

          // Non-interactive mode requires container name argument
          if (!isInteractiveMode()) {
            return exitWithError({
              message:
                'Container name is required in non-interactive mode. Usage: spindb delete <name> --force',
            })
          }

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
          return exitWithError({
            message: `Container "${containerName}" not found`,
            json: options.json,
          })
        }

        if (!options.yes && !options.force && !options.json) {
          // Detect non-interactive mode (piped input, scripts, CI)
          if (!isInteractiveMode()) {
            return exitWithError({
              message:
                'Cannot prompt for confirmation in non-interactive mode. Use --force or --yes to skip confirmation',
            })
          }

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
            const stopSpinner = options.json
              ? null
              : createSpinner(`Stopping ${containerName}...`)
            stopSpinner?.start()

            const engine = getEngine(config.engine)
            await engine.stop(config)

            stopSpinner?.succeed(`Stopped "${containerName}"`)
          } else {
            return exitWithError({
              message: `Container "${containerName}" is running. Stop it first or use --force`,
              json: options.json,
            })
          }
        }

        const deleteSpinner = options.json
          ? null
          : createSpinner(`Deleting ${containerName}...`)
        deleteSpinner?.start()

        await containerManager.delete(containerName, { force: true })

        deleteSpinner?.succeed(`Container "${containerName}" deleted`)

        if (options.json) {
          const metadata = await getEngineMetadata(config.engine)
          console.log(
            JSON.stringify({
              success: true,
              deleted: containerName,
              container: containerName,
              engine: config.engine,
              ...metadata,
            }),
          )
        }
      } catch (error) {
        const e = error as Error
        return exitWithError({ message: e.message, json: options.json })
      }
    },
  )
