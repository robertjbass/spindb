import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptContainerSelect, promptContainerName } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiError, uiWarning, connectionBox } from '../ui/theme'

export const cloneCommand = new Command('clone')
  .description('Clone a container with all its data')
  .argument('[source]', 'Source container name')
  .argument('[target]', 'Target container name')
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (
      source: string | undefined,
      target: string | undefined,
      options: { json?: boolean },
    ) => {
      try {
        let sourceName = source
        let targetName = target

        if (!sourceName) {
          // JSON mode requires source container name argument
          if (options.json) {
            console.log(
              JSON.stringify({ error: 'Source container name is required' }),
            )
            process.exit(1)
          }

          const containers = await containerManager.list()
          const stopped = containers.filter((c) => c.status !== 'running')

          if (containers.length === 0) {
            console.log(
              uiWarning('No containers found. Create one with: spindb create'),
            )
            return
          }

          if (stopped.length === 0) {
            console.log(
              uiWarning(
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

        const sourceConfig = await containerManager.getConfig(sourceName)
        if (!sourceConfig) {
          if (options.json) {
            console.log(
              JSON.stringify({ error: `Container "${sourceName}" not found` }),
            )
          } else {
            console.error(uiError(`Container "${sourceName}" not found`))
          }
          process.exit(1)
        }

        const running = await processManager.isRunning(sourceName, {
          engine: sourceConfig.engine,
        })
        if (running) {
          const errorMsg = `Container "${sourceName}" is running. Stop it first to clone.`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        if (!targetName) {
          // JSON mode requires target container name argument
          if (options.json) {
            console.log(
              JSON.stringify({ error: 'Target container name is required' }),
            )
            process.exit(1)
          }
          targetName = await promptContainerName(`${sourceName}-copy`)
        }

        // Check if target container already exists
        if (
          await containerManager.exists(targetName, {
            engine: sourceConfig.engine,
          })
        ) {
          const errorMsg = `Container "${targetName}" already exists`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        const cloneSpinner = createSpinner(
          `Cloning ${sourceName} to ${targetName}...`,
        )
        cloneSpinner.start()

        const newConfig = await containerManager.clone(sourceName, targetName)

        cloneSpinner.succeed(`Cloned "${sourceName}" to "${targetName}"`)

        const engine = getEngine(newConfig.engine)
        const connectionString = engine.getConnectionString(newConfig)

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              source: sourceName,
              target: targetName,
              newPort: newConfig.port,
              connectionString,
            }),
          )
        } else {
          console.log()
          console.log(
            connectionBox(targetName, connectionString, newConfig.port),
          )
          console.log()
          console.log(chalk.gray('  Start the cloned container:'))
          console.log(chalk.cyan(`  spindb start ${targetName}`))
          console.log()
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
