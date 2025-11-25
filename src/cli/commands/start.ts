import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '@/core/container-manager'
import { portManager } from '@/core/port-manager'
import { processManager } from '@/core/process-manager'
import { getEngine } from '@/engines'
import { promptContainerSelect } from '@/cli/ui/prompts'
import { createSpinner } from '@/cli/ui/spinner'
import { error, warning } from '@/cli/ui/theme'

export const startCommand = new Command('start')
  .description('Start a container')
  .argument('[name]', 'Container name')
  .action(async (name: string | undefined) => {
    try {
      let containerName = name

      // Interactive selection if no name provided
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

      // Get container config
      const config = await containerManager.getConfig(containerName)
      if (!config) {
        console.error(error(`Container "${containerName}" not found`))
        process.exit(1)
      }

      // Check if already running
      const running = await processManager.isRunning(containerName)
      if (running) {
        console.log(warning(`Container "${containerName}" is already running`))
        return
      }

      // Check port availability
      const portAvailable = await portManager.isPortAvailable(config.port)
      if (!portAvailable) {
        // Try to find a new port
        const { port: newPort } = await portManager.findAvailablePort()
        console.log(
          warning(
            `Port ${config.port} is in use, switching to port ${newPort}`,
          ),
        )
        config.port = newPort
        await containerManager.updateConfig(containerName, { port: newPort })
      }

      // Get engine and start
      const engine = getEngine(config.engine)

      const spinner = createSpinner(`Starting ${containerName}...`)
      spinner.start()

      await engine.start(config)
      await containerManager.updateConfig(containerName, { status: 'running' })

      spinner.succeed(`Container "${containerName}" started`)

      // Show connection info
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
