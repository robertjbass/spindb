import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptContainerSelect } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiSuccess, uiError, uiWarning } from '../ui/theme'
import { Engine } from '../../types'

export const stopCommand = new Command('stop')
  .description('Stop a container')
  .argument('[name]', 'Container name')
  .option('-a, --all', 'Stop all running containers')
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (
      name: string | undefined,
      options: { all?: boolean; json?: boolean },
    ) => {
      try {
        if (options.all) {
          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            console.log(uiWarning('No running containers found'))
            return
          }

          const stoppedNames: string[] = []

          for (const container of running) {
            const spinner = options.json
              ? null
              : createSpinner(`Stopping ${container.name}...`)
            spinner?.start()

            const engine = getEngine(container.engine)

            // For PostgreSQL, check if engine binary is installed
            let usedFallback = false
            let stopFailed = false
            if (container.engine === Engine.PostgreSQL) {
              const isInstalled = await engine.isBinaryInstalled(
                container.version,
              )
              if (!isInstalled) {
                if (spinner) {
                  spinner.text = `Stopping ${container.name} (engine missing, using fallback)...`
                }
                const killed = await processManager.killProcess(
                  container.name,
                  {
                    engine: container.engine,
                  },
                )
                if (!killed) {
                  spinner?.fail(`Failed to stop "${container.name}"`)
                  console.log(
                    chalk.gray(
                      `  The PostgreSQL ${container.version} engine is not installed.`,
                    ),
                  )
                  console.log(
                    chalk.gray(
                      `  Run "spindb engines download postgresql ${container.version.split('.')[0]}" to reinstall.`,
                    ),
                  )
                  stopFailed = true
                } else {
                  usedFallback = true
                }
              }
            }

            if (stopFailed) {
              continue
            }

            if (!usedFallback) {
              await engine.stop(container)
            }

            await containerManager.updateConfig(container.name, {
              status: 'stopped',
            })

            spinner?.succeed(`Stopped "${container.name}"`)
            stoppedNames.push(container.name)
          }

          if (options.json) {
            console.log(
              JSON.stringify({
                success: true,
                stopped: stoppedNames,
                count: stoppedNames.length,
              }),
            )
          } else {
            console.log(uiSuccess(`Stopped ${running.length} container(s)`))
          }
          return
        }

        let containerName = name

        if (!containerName) {
          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            console.log(uiWarning('No running containers found'))
            return
          }

          const selected = await promptContainerSelect(
            running,
            'Select container to stop:',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(uiError(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const running = await processManager.isRunning(containerName, {
          engine: config.engine,
        })
        if (!running) {
          console.log(uiWarning(`Container "${containerName}" is not running`))
          return
        }

        const engine = getEngine(config.engine)

        const spinner = options.json
          ? null
          : createSpinner(`Stopping ${containerName}...`)
        spinner?.start()

        // For PostgreSQL, check if engine binary is installed
        // If not, use fallback process kill
        let usedFallback = false
        if (config.engine === Engine.PostgreSQL) {
          const isInstalled = await engine.isBinaryInstalled(
            config.version,
          )
          if (!isInstalled) {
            if (spinner) {
              spinner.text = `Stopping ${containerName} (engine missing, using fallback)...`
            }
            const killed = await processManager.killProcess(
              containerName,
              {
                engine: config.engine,
              },
            )
            if (!killed) {
              spinner?.fail(`Failed to stop "${containerName}"`)
              console.log(
                chalk.gray(
                  `  The PostgreSQL ${config.version} engine is not installed.`,
                ),
              )
              console.log(
                chalk.gray(
                  `  Run "spindb engines download postgresql ${config.version.split('.')[0]}" to reinstall.`,
                ),
              )
              process.exit(1)
            }
            usedFallback = true
          }
        }

        if (!usedFallback) {
          await engine.stop(config)
        }

        await containerManager.updateConfig(containerName, {
          status: 'stopped',
        })

        spinner?.succeed(`Container "${containerName}" stopped`)

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              stopped: [containerName],
              count: 1,
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
