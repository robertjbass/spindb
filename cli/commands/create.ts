import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { portManager } from '../../core/port-manager'
import { getEngine } from '../../engines'
import { defaults } from '../../config/defaults'
import { promptCreateOptions } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { header, error, connectionBox } from '../ui/theme'

export const createCommand = new Command('create')
  .description('Create a new database container')
  .argument('[name]', 'Container name')
  .option('-e, --engine <engine>', 'Database engine', defaults.engine)
  .option(
    '--pg-version <version>',
    'PostgreSQL version',
    defaults.postgresVersion,
  )
  .option('-d, --database <database>', 'Database name')
  .option('-p, --port <port>', 'Port number')
  .option('--no-start', 'Do not start the container after creation')
  .action(
    async (
      name: string | undefined,
      options: {
        engine: string
        pgVersion: string
        database?: string
        port?: string
        start: boolean
      },
    ) => {
      try {
        let containerName = name
        let engine = options.engine
        let version = options.pgVersion
        let database = options.database

        // Interactive mode if no name provided
        if (!containerName) {
          const answers = await promptCreateOptions()
          containerName = answers.name
          engine = answers.engine
          version = answers.version
          database = answers.database
        }

        // Default database name to container name if not specified
        database = database ?? containerName

        console.log(header('Creating Database Container'))
        console.log()

        // Get the engine
        const dbEngine = getEngine(engine)

        // Find available port
        const portSpinner = createSpinner('Finding available port...')
        portSpinner.start()

        let port: number
        if (options.port) {
          port = parseInt(options.port, 10)
          const available = await portManager.isPortAvailable(port)
          if (!available) {
            portSpinner.fail(`Port ${port} is already in use`)
            process.exit(1)
          }
          portSpinner.succeed(`Using port ${port}`)
        } else {
          const { port: foundPort, isDefault } =
            await portManager.findAvailablePort()
          port = foundPort
          if (isDefault) {
            portSpinner.succeed(`Using default port ${port}`)
          } else {
            portSpinner.warn(`Default port 5432 is in use, using port ${port}`)
          }
        }

        // Ensure binaries are available
        const binarySpinner = createSpinner(
          `Checking PostgreSQL ${version} binaries...`,
        )
        binarySpinner.start()

        const isInstalled = await dbEngine.isBinaryInstalled(version)
        if (isInstalled) {
          binarySpinner.succeed(`PostgreSQL ${version} binaries ready (cached)`)
        } else {
          binarySpinner.text = `Downloading PostgreSQL ${version} binaries...`
          await dbEngine.ensureBinaries(version, ({ message }) => {
            binarySpinner.text = message
          })
          binarySpinner.succeed(`PostgreSQL ${version} binaries downloaded`)
        }

        // Create container
        const createSpinnerInstance = createSpinner('Creating container...')
        createSpinnerInstance.start()

        await containerManager.create(containerName, {
          engine: dbEngine.name,
          version,
          port,
          database,
        })

        createSpinnerInstance.succeed('Container created')

        // Initialize database cluster
        const initSpinner = createSpinner('Initializing database cluster...')
        initSpinner.start()

        await dbEngine.initDataDir(containerName, version, {
          superuser: defaults.superuser,
        })

        initSpinner.succeed('Database cluster initialized')

        // Start container if requested
        if (options.start !== false) {
          const startSpinner = createSpinner('Starting PostgreSQL...')
          startSpinner.start()

          const config = await containerManager.getConfig(containerName)
          if (config) {
            await dbEngine.start(config)
            await containerManager.updateConfig(containerName, {
              status: 'running',
            })
          }

          startSpinner.succeed('PostgreSQL started')

          // Create the user's database (if different from 'postgres')
          if (config && database !== 'postgres') {
            const dbSpinner = createSpinner(
              `Creating database "${database}"...`,
            )
            dbSpinner.start()

            await dbEngine.createDatabase(config, database)

            dbSpinner.succeed(`Database "${database}" created`)
          }
        }

        // Show success message
        const config = await containerManager.getConfig(containerName)
        if (config) {
          const connectionString = dbEngine.getConnectionString(config)

          console.log()
          console.log(connectionBox(containerName, connectionString, port))
          console.log()
          console.log(chalk.gray('  Connect with:'))
          console.log(chalk.cyan(`  spindb connect ${containerName}`))
          console.log()
        }
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
