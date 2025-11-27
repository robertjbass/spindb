import { Command } from 'commander'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { portManager } from '../../core/port-manager'
import { getEngine } from '../../engines'
import { defaults } from '../../config/defaults'
import {
  promptCreateOptions,
  promptInstallDependencies,
  promptContainerName,
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { header, error, connectionBox } from '../ui/theme'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { platform } from 'os'
import { getMissingDependencies } from '../../core/dependency-manager'

/**
 * Detect if a location string is a connection string or a file path
 */
function detectLocationType(
  location: string,
): 'connection' | 'file' | 'not_found' {
  // Check if it's a connection string
  if (
    location.startsWith('postgresql://') ||
    location.startsWith('postgres://')
  ) {
    return 'connection'
  }

  // Check if file exists
  if (existsSync(location)) {
    return 'file'
  }

  return 'not_found'
}

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
  .option(
    '--from <location>',
    'Restore from a dump file or connection string after creation',
  )
  .action(
    async (
      name: string | undefined,
      options: {
        engine: string
        pgVersion: string
        database?: string
        port?: string
        start: boolean
        from?: string
      },
    ) => {
      let tempDumpPath: string | null = null

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

        // Validate --from location if provided
        let restoreLocation: string | null = null
        let restoreType: 'connection' | 'file' | null = null

        if (options.from) {
          const locationType = detectLocationType(options.from)

          if (locationType === 'not_found') {
            console.error(error(`Location not found: ${options.from}`))
            console.log(
              chalk.gray(
                '  Provide a valid file path or connection string (postgresql://...)',
              ),
            )
            process.exit(1)
          }

          restoreLocation = options.from
          restoreType = locationType

          // If using --from, we must start the container
          if (options.start === false) {
            console.error(
              error(
                'Cannot use --no-start with --from (restore requires running container)',
              ),
            )
            process.exit(1)
          }
        }

        console.log(header('Creating Database Container'))
        console.log()

        // Get the engine
        const dbEngine = getEngine(engine)

        // Check for required client tools BEFORE creating anything
        const depsSpinner = createSpinner('Checking required tools...')
        depsSpinner.start()

        let missingDeps = await getMissingDependencies(engine)
        if (missingDeps.length > 0) {
          depsSpinner.warn(
            `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
          )

          // Offer to install
          const installed = await promptInstallDependencies(
            missingDeps[0].binary,
            engine,
          )

          if (!installed) {
            process.exit(1)
          }

          // Verify installation worked
          missingDeps = await getMissingDependencies(engine)
          if (missingDeps.length > 0) {
            console.error(
              error(
                `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
              ),
            )
            process.exit(1)
          }

          console.log(chalk.green('  ✓ All required tools are now available'))
          console.log()
        } else {
          depsSpinner.succeed('Required tools available')
        }

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

        // Check if container name already exists and prompt for new name if needed
        while (await containerManager.exists(containerName)) {
          console.log(
            chalk.yellow(`  Container "${containerName}" already exists.`),
          )
          containerName = await promptContainerName()
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

          // Handle --from restore if specified
          if (restoreLocation && restoreType && config) {
            let backupPath = ''

            if (restoreType === 'connection') {
              // Create dump from remote database
              const timestamp = Date.now()
              tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}.dump`)

              let dumpSuccess = false
              let attempts = 0
              const maxAttempts = 2 // Allow one retry after installing deps

              while (!dumpSuccess && attempts < maxAttempts) {
                attempts++
                const dumpSpinner = createSpinner(
                  'Creating dump from remote database...',
                )
                dumpSpinner.start()

                try {
                  await dbEngine.dumpFromConnectionString(
                    restoreLocation,
                    tempDumpPath,
                  )
                  dumpSpinner.succeed('Dump created from remote database')
                  backupPath = tempDumpPath
                  dumpSuccess = true
                } catch (err) {
                  const e = err as Error
                  dumpSpinner.fail('Failed to create dump')

                  // Check if this is a missing tool error
                  if (
                    e.message.includes('pg_dump not found') ||
                    e.message.includes('ENOENT')
                  ) {
                    const installed = await promptInstallDependencies('pg_dump')
                    if (!installed) {
                      process.exit(1)
                    }
                    // Loop will retry
                    continue
                  }

                  console.log()
                  console.error(error('pg_dump error:'))
                  console.log(chalk.gray(`  ${e.message}`))
                  process.exit(1)
                }
              }

              // Safety check - should never reach here without backupPath set
              if (!dumpSuccess) {
                console.error(error('Failed to create dump after retries'))
                process.exit(1)
              }
            } else {
              backupPath = restoreLocation
            }

            // Detect backup format
            const detectSpinner = createSpinner('Detecting backup format...')
            detectSpinner.start()

            const format = await dbEngine.detectBackupFormat(backupPath)
            detectSpinner.succeed(`Detected: ${format.description}`)

            // Restore backup
            const restoreSpinner = createSpinner('Restoring backup...')
            restoreSpinner.start()

            const result = await dbEngine.restore(config, backupPath, {
              database,
              createDatabase: false, // Already created above
            })

            if (result.code === 0 || !result.stderr) {
              restoreSpinner.succeed('Backup restored successfully')
            } else {
              restoreSpinner.warn('Restore completed with warnings')
              if (result.stderr) {
                console.log(chalk.yellow('\n  Warnings:'))
                const lines = result.stderr.split('\n').slice(0, 5)
                lines.forEach((line) => {
                  if (line.trim()) {
                    console.log(chalk.gray(`    ${line}`))
                  }
                })
                if (result.stderr.split('\n').length > 5) {
                  console.log(chalk.gray('    ...'))
                }
              }
            }
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

          // Copy connection string to clipboard
          if (options.start !== false) {
            try {
              const cmd = platform() === 'darwin' ? 'pbcopy' : 'xclip'
              const args =
                platform() === 'darwin' ? [] : ['-selection', 'clipboard']

              await new Promise<void>((resolve, reject) => {
                const proc = spawn(cmd, args, {
                  stdio: ['pipe', 'inherit', 'inherit'],
                })
                proc.stdin?.write(connectionString)
                proc.stdin?.end()
                proc.on('close', (code) => {
                  if (code === 0) resolve()
                  else
                    reject(
                      new Error(`Clipboard command exited with code ${code}`),
                    )
                })
                proc.on('error', reject)
              })

              console.log(chalk.gray('  Connection string copied to clipboard'))
            } catch {
              // Ignore clipboard errors
            }
          }

          console.log()
        }
      } catch (err) {
        const e = err as Error

        // Check if this is a missing tool error
        if (
          e.message.includes('pg_restore not found') ||
          e.message.includes('psql not found') ||
          e.message.includes('pg_dump not found')
        ) {
          const missingTool = e.message.includes('pg_restore')
            ? 'pg_restore'
            : e.message.includes('pg_dump')
              ? 'pg_dump'
              : 'psql'
          const installed = await promptInstallDependencies(missingTool)
          if (installed) {
            console.log(
              chalk.yellow(
                '  Please re-run your command to continue.',
              ),
            )
          }
          process.exit(1)
        }

        console.error(error(e.message))
        process.exit(1)
      } finally {
        // Clean up temp file if we created one
        if (tempDumpPath) {
          try {
            await rm(tempDumpPath, { force: true })
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    },
  )
