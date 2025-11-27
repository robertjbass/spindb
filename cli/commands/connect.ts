import { Command } from 'commander'
import { spawn } from 'child_process'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { getEngineDefaults } from '../../config/defaults'
import { promptContainerSelect } from '../ui/prompts'
import { error, warning, info } from '../ui/theme'

export const connectCommand = new Command('connect')
  .description('Connect to a container with database client')
  .argument('[name]', 'Container name')
  .option('-d, --database <name>', 'Database name')
  .action(async (name: string | undefined, options: { database?: string }) => {
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

      const { engine: engineName } = config
      const engineDefaults = getEngineDefaults(engineName)

      // Default database: container's database or superuser
      const database = options.database ?? config.database ?? engineDefaults.superuser

      // Check if running
      const running = await processManager.isRunning(containerName, {
        engine: engineName,
      })
      if (!running) {
        console.error(
          error(`Container "${containerName}" is not running. Start it first.`),
        )
        process.exit(1)
      }

      // Get engine
      const engine = getEngine(engineName)
      const connectionString = engine.getConnectionString(config, database)

      console.log(info(`Connecting to ${containerName}:${database}...`))
      console.log()

      // Build client command based on engine
      let clientCmd: string
      let clientArgs: string[]

      if (engineName === 'mysql') {
        // MySQL: mysql -h 127.0.0.1 -P port -u root database
        clientCmd = 'mysql'
        clientArgs = [
          '-h', '127.0.0.1',
          '-P', String(config.port),
          '-u', engineDefaults.superuser,
          database,
        ]
      } else {
        // PostgreSQL: psql connection_string
        clientCmd = 'psql'
        clientArgs = [connectionString]
      }

      const clientProcess = spawn(clientCmd, clientArgs, {
        stdio: 'inherit',
      })

      clientProcess.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          console.log(warning(`${clientCmd} not found on your system.`))
          console.log()
          console.log(chalk.gray('  Install client tools or connect manually:'))
          console.log(chalk.cyan(`  ${connectionString}`))
          console.log()

          if (engineName === 'mysql') {
            console.log(chalk.gray('  On macOS with Homebrew:'))
            console.log(chalk.cyan('  brew install mysql-client'))
          } else {
            console.log(chalk.gray('  On macOS with Homebrew:'))
            console.log(
              chalk.cyan('  brew install libpq && brew link --force libpq'),
            )
          }
          console.log()
        } else {
          console.error(error(err.message))
        }
      })

      await new Promise<void>((resolve) => {
        clientProcess.on('close', () => resolve())
      })
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })
