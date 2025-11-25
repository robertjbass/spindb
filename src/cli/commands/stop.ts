import { Command } from 'commander'
import { containerManager } from '@/core/container-manager'
import { processManager } from '@/core/process-manager'
import { getEngine } from '@/engines'
import { promptContainerSelect } from '@/cli/ui/prompts'
import { createSpinner } from '@/cli/ui/spinner'
import { success, error, warning } from '@/cli/ui/theme'

export const stopCommand = new Command('stop')
  .description('Stop a container')
  .argument('[name]', 'Container name')
  .option('-a, --all', 'Stop all running containers')
  .action(async (name: string | undefined, options: { all?: boolean }) => {
    try {
      if (options.all) {
        // Stop all running containers
        const containers = await containerManager.list()
        const running = containers.filter((c) => c.status === 'running')

        if (running.length === 0) {
          console.log(warning('No running containers found'))
          return
        }

        for (const container of running) {
          const spinner = createSpinner(`Stopping ${container.name}...`)
          spinner.start()

          const engine = getEngine(container.engine)
          await engine.stop(container)
          await containerManager.updateConfig(container.name, {
            status: 'stopped',
          })

          spinner.succeed(`Stopped "${container.name}"`)
        }

        console.log(success(`Stopped ${running.length} container(s)`))
        return
      }

      let containerName = name

      // Interactive selection if no name provided
      if (!containerName) {
        const containers = await containerManager.list()
        const running = containers.filter((c) => c.status === 'running')

        if (running.length === 0) {
          console.log(warning('No running containers found'))
          return
        }

        const selected = await promptContainerSelect(
          running,
          'Select container to stop:',
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

      // Check if running
      const running = await processManager.isRunning(containerName)
      if (!running) {
        console.log(warning(`Container "${containerName}" is not running`))
        return
      }

      // Get engine and stop
      const engine = getEngine(config.engine)

      const spinner = createSpinner(`Stopping ${containerName}...`)
      spinner.start()

      await engine.stop(config)
      await containerManager.updateConfig(containerName, { status: 'stopped' })

      spinner.succeed(`Container "${containerName}" stopped`)
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })
