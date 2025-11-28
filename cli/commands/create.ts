import { Command } from 'commander'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { portManager } from '../../core/port-manager'
import { getEngine } from '../../engines'
import { getEngineDefaults } from '../../config/defaults'
import {
  promptCreateOptions,
  promptInstallDependencies,
  promptContainerName,
  promptConfirm,
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { header, error, connectionBox } from '../ui/theme'
import { tmpdir } from 'os'
import { join } from 'path'
import { getMissingDependencies } from '../../core/dependency-manager'
import { platformService } from '../../core/platform-service'
import { startWithRetry } from '../../core/start-with-retry'
import { TransactionManager } from '../../core/transaction-manager'
import type { EngineName } from '../../types'

/**
 * Detect if a location string is a connection string or a file path
 * Also infers engine from connection string scheme
 */
function detectLocationType(location: string): {
  type: 'connection' | 'file' | 'not_found'
  inferredEngine?: EngineName
} {
  // Check for PostgreSQL connection string
  if (
    location.startsWith('postgresql://') ||
    location.startsWith('postgres://')
  ) {
    return { type: 'connection', inferredEngine: 'postgresql' }
  }

  // Check for MySQL connection string
  if (location.startsWith('mysql://')) {
    return { type: 'connection', inferredEngine: 'mysql' }
  }

  // Check if file exists
  if (existsSync(location)) {
    return { type: 'file' }
  }

  return { type: 'not_found' }
}

export const createCommand = new Command('create')
  .description('Create a new database container')
  .argument('[name]', 'Container name')
  .option('-e, --engine <engine>', 'Database engine (postgresql, mysql)')
  .option('-v, --version <version>', 'Database version')
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
        engine?: string
        version?: string
        database?: string
        port?: string
        start: boolean
        from?: string
      },
    ) => {
      let tempDumpPath: string | null = null

      try {
        let containerName = name
        let engine: EngineName = (options.engine as EngineName) || 'postgresql'
        let version = options.version
        let database = options.database

        // Validate --from location if provided (before prompts so we can infer engine)
        let restoreLocation: string | null = null
        let restoreType: 'connection' | 'file' | null = null

        if (options.from) {
          const locationInfo = detectLocationType(options.from)

          if (locationInfo.type === 'not_found') {
            console.error(error(`Location not found: ${options.from}`))
            console.log(
              chalk.gray(
                '  Provide a valid file path or connection string (postgresql://, mysql://)',
              ),
            )
            process.exit(1)
          }

          restoreLocation = options.from
          restoreType = locationInfo.type

          // Infer engine from connection string if not explicitly set
          if (!options.engine && locationInfo.inferredEngine) {
            engine = locationInfo.inferredEngine
            console.log(
              chalk.gray(
                `  Inferred engine "${engine}" from connection string`,
              ),
            )
          }

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

        // Get engine defaults for port range and default version
        const engineDefaults = getEngineDefaults(engine)

        // Set version to engine default if not specified
        if (!version) {
          version = engineDefaults.defaultVersion
        }

        // Interactive mode if no name provided
        if (!containerName) {
          const answers = await promptCreateOptions()
          containerName = answers.name
          engine = answers.engine as EngineName
          version = answers.version
          database = answers.database
        }

        // Default database name to container name if not specified
        database = database ?? containerName

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
            await portManager.findAvailablePort({
              preferredPort: engineDefaults.defaultPort,
              portRange: engineDefaults.portRange,
            })
          port = foundPort
          if (isDefault) {
            portSpinner.succeed(`Using default port ${port}`)
          } else {
            portSpinner.warn(
              `Default port ${engineDefaults.defaultPort} is in use, using port ${port}`,
            )
          }
        }

        // Ensure binaries are available
        const binarySpinner = createSpinner(
          `Checking ${dbEngine.displayName} ${version} binaries...`,
        )
        binarySpinner.start()

        const isInstalled = await dbEngine.isBinaryInstalled(version)
        if (isInstalled) {
          binarySpinner.succeed(
            `${dbEngine.displayName} ${version} binaries ready (cached)`,
          )
        } else {
          binarySpinner.text = `Downloading ${dbEngine.displayName} ${version} binaries...`
          await dbEngine.ensureBinaries(version, ({ message }) => {
            binarySpinner.text = message
          })
          binarySpinner.succeed(
            `${dbEngine.displayName} ${version} binaries downloaded`,
          )
        }

        // Check if container name already exists and prompt for new name if needed
        while (await containerManager.exists(containerName)) {
          console.log(
            chalk.yellow(`  Container "${containerName}" already exists.`),
          )
          containerName = await promptContainerName()
        }

        // Create transaction manager for rollback support
        const tx = new TransactionManager()

        // Create container
        const createSpinnerInstance = createSpinner('Creating container...')
        createSpinnerInstance.start()

        try {
          await containerManager.create(containerName, {
            engine: dbEngine.name as EngineName,
            version,
            port,
            database,
          })

          // Register rollback action for container deletion
          tx.addRollback({
            description: `Delete container "${containerName}"`,
            execute: async () => {
              await containerManager.delete(containerName, { force: true })
            },
          })

          createSpinnerInstance.succeed('Container created')
        } catch (err) {
          createSpinnerInstance.fail('Failed to create container')
          throw err
        }

        // Initialize database cluster
        const initSpinner = createSpinner('Initializing database cluster...')
        initSpinner.start()

        try {
          await dbEngine.initDataDir(containerName, version, {
            superuser: engineDefaults.superuser,
          })
          // Note: initDataDir is covered by the container delete rollback
          initSpinner.succeed('Database cluster initialized')
        } catch (err) {
          initSpinner.fail('Failed to initialize database cluster')
          await tx.rollback()
          throw err
        }

        // Determine if we should start the container
        // If --from is specified, we must start to restore
        // If --no-start is specified, don't start
        // Otherwise, ask the user
        let shouldStart = false
        if (restoreLocation) {
          // Must start to restore data
          shouldStart = true
        } else if (options.start === false) {
          // User explicitly requested no start
          shouldStart = false
        } else {
          // Ask the user
          console.log()
          shouldStart = await promptConfirm(
            `Start ${containerName} now?`,
            true,
          )
        }

        // Get container config for starting and restoration
        const config = await containerManager.getConfig(containerName)

        // Start container if requested
        if (shouldStart && config) {
          const startSpinner = createSpinner(
            `Starting ${dbEngine.displayName}...`,
          )
          startSpinner.start()

          try {
            // Use startWithRetry to handle port race conditions
            const result = await startWithRetry({
              engine: dbEngine,
              config,
              onPortChange: (oldPort, newPort) => {
                startSpinner.text = `Port ${oldPort} was in use, retrying with port ${newPort}...`
                port = newPort
              },
            })

            if (!result.success) {
              startSpinner.fail(`Failed to start ${dbEngine.displayName}`)
              await tx.rollback()
              if (result.error) {
                throw result.error
              }
              throw new Error('Failed to start container')
            }

            // Register rollback action for stopping the container
            tx.addRollback({
              description: `Stop container "${containerName}"`,
              execute: async () => {
                try {
                  await dbEngine.stop(config)
                } catch {
                  // Ignore stop errors during rollback
                }
              },
            })

            await containerManager.updateConfig(containerName, {
              status: 'running',
            })

            if (result.retriesUsed > 0) {
              startSpinner.warn(
                `${dbEngine.displayName} started on port ${result.finalPort} (original port was in use)`,
              )
            } else {
              startSpinner.succeed(`${dbEngine.displayName} started`)
            }
          } catch (err) {
            if (!startSpinner.isSpinning) {
              // Error was already handled above
            } else {
              startSpinner.fail(`Failed to start ${dbEngine.displayName}`)
            }
            await tx.rollback()
            throw err
          }

          // Create the user's database (if different from default)
          const defaultDb = engineDefaults.superuser // postgres or root
          if (database !== defaultDb) {
            const dbSpinner = createSpinner(
              `Creating database "${database}"...`,
            )
            dbSpinner.start()

            try {
              await dbEngine.createDatabase(config, database)
              dbSpinner.succeed(`Database "${database}" created`)
            } catch (err) {
              dbSpinner.fail(`Failed to create database "${database}"`)
              await tx.rollback()
              throw err
            }
          }
        }

        // Handle --from restore if specified (only if started)
        if (restoreLocation && restoreType && config && shouldStart) {
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

        // Commit the transaction - all operations succeeded
        tx.commit()

        // Show success message
        const finalConfig = await containerManager.getConfig(containerName)
        if (finalConfig) {
          const connectionString = dbEngine.getConnectionString(finalConfig)

          console.log()
          console.log(connectionBox(containerName, connectionString, finalConfig.port))
          console.log()

          if (shouldStart) {
            console.log(chalk.gray('  Connect with:'))
            console.log(chalk.cyan(`  spindb connect ${containerName}`))

            // Copy connection string to clipboard
            const copied = await platformService.copyToClipboard(connectionString)
            if (copied) {
              console.log(chalk.gray('  Connection string copied to clipboard'))
            }
          } else {
            console.log(chalk.gray('  Start the container:'))
            console.log(chalk.cyan(`  spindb start ${containerName}`))
          }

          console.log()
        }
      } catch (err) {
        const e = err as Error

        // Check if this is a missing tool error (PostgreSQL or MySQL)
        const missingToolPatterns = [
          // PostgreSQL
          'pg_restore not found',
          'psql not found',
          'pg_dump not found',
          // MySQL
          'mysql not found',
          'mysqldump not found',
          'mysqld not found',
        ]

        const matchingPattern = missingToolPatterns.find((p) =>
          e.message.includes(p),
        )

        if (matchingPattern) {
          const missingTool = matchingPattern.replace(' not found', '')
          const installed = await promptInstallDependencies(missingTool)
          if (installed) {
            console.log(
              chalk.yellow('  Please re-run your command to continue.'),
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
