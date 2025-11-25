import { Command } from 'commander'
import { spawn } from 'child_process'
import chalk from 'chalk'
import { containerManager } from '@/core/container-manager'
import { processManager } from '@/core/process-manager'
import { getEngine } from '@/engines'
import { promptContainerSelect } from '@/cli/ui/prompts'
import { error, warning, info } from '@/cli/ui/theme'

export const connectCommand = new Command('connect')
  .description('Connect to a container with psql')
  .argument('[name]', 'Container name')
  .option('-d, --database <name>', 'Database name', 'postgres')
  .action(async (name: string | undefined, options: { database: string }) => {
    try {
      let containerName = name

      // Interactive selection if no name provided
      if (!containerName) {
        const containers = await containerManager.list()
        const running = containers.filter((c) => c.status === 'running')

        if (running.length === 0) {
          if (containers.length === 0) {
            console.log(
              warning('No containers found. Create one with: spindb create'),
            )
          } else {
            console.log(
              warning(
                'No running containers. Start one first with: spindb start',
              ),
            )
          }
          return
        }

        const selected = await promptContainerSelect(
          running,
          'Select container to connect to:',
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
        console.error(
          error(`Container "${containerName}" is not running. Start it first.`),
        )
        process.exit(1)
      }

      // Get engine
      const engine = getEngine(config.engine)
      const connectionString = engine.getConnectionString(
        config,
        options.database,
      )

      console.log(info(`Connecting to ${containerName}:${options.database}...`))
      console.log()

      // Try to use system psql (the bundled binaries don't include psql)
      const psqlProcess = spawn('psql', [connectionString], {
        stdio: 'inherit',
      })

      psqlProcess.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          console.log(warning('psql not found on your system.'))
          console.log()
          console.log(
            chalk.gray(
              '  Install PostgreSQL client tools or connect manually:',
            ),
          )
          console.log(chalk.cyan(`  ${connectionString}`))
          console.log()
          console.log(chalk.gray('  On macOS with Homebrew:'))
          console.log(
            chalk.cyan('  brew install libpq && brew link --force libpq'),
          )
          console.log()
        } else {
          console.error(error(err.message))
        }
      })

      await new Promise<void>((resolve) => {
        psqlProcess.on('close', () => resolve())
      })
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })
