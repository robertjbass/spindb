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
import { Engine } from '../../types'

function detectLocationType(location: string): {
  type: 'connection' | 'file' | 'not_found'
  inferredEngine?: Engine
} {
  if (
    location.startsWith('postgresql://') ||
    location.startsWith('postgres://')
  ) {
    return { type: 'connection', inferredEngine: Engine.PostgreSQL }
  }

  if (location.startsWith('mysql://')) {
    return { type: 'connection', inferredEngine: Engine.MySQL }
  }

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
        let engine: Engine = (options.engine as Engine) || Engine.PostgreSQL
        let version = options.version
        let database = options.database

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

          if (!options.engine && locationInfo.inferredEngine) {
            engine = locationInfo.inferredEngine
            console.log(
              chalk.gray(
                `  Inferred engine "${engine}" from connection string`,
              ),
            )
          }

          if (options.start === false) {
            console.error(
              error(
                'Cannot use --no-start with --from (restore requires running container)',
              ),
            )
            process.exit(1)
          }
        }

        const engineDefaults = getEngineDefaults(engine)

        if (!version) {
          version = engineDefaults.defaultVersion
        }

        if (!containerName) {
          const answers = await promptCreateOptions()
          containerName = answers.name
          engine = answers.engine as Engine
          version = answers.version
          database = answers.database
        }

        database = database ?? containerName

        console.log(header('Creating Database Container'))
        console.log()

        const dbEngine = getEngine(engine)

        const depsSpinner = createSpinner('Checking required tools...')
        depsSpinner.start()

        let missingDeps = await getMissingDependencies(engine)
        if (missingDeps.length > 0) {
          depsSpinner.warn(
            `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
          )

          const installed = await promptInstallDependencies(
            missingDeps[0].binary,
            engine,
          )

          if (!installed) {
            process.exit(1)
          }

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

        while (await containerManager.exists(containerName)) {
          console.log(
            chalk.yellow(`  Container "${containerName}" already exists.`),
          )
          containerName = await promptContainerName()
        }

        const tx = new TransactionManager()

        const createSpinnerInstance = createSpinner('Creating container...')
        createSpinnerInstance.start()

        try {
          await containerManager.create(containerName, {
            engine: dbEngine.name as Engine,
            version,
            port,
            database,
          })

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

        const initSpinner = createSpinner('Initializing database cluster...')
        initSpinner.start()

        try {
          await dbEngine.initDataDir(containerName, version, {
            superuser: engineDefaults.superuser,
          })
          initSpinner.succeed('Database cluster initialized')
        } catch (err) {
          initSpinner.fail('Failed to initialize database cluster')
          await tx.rollback()
          throw err
        }

        // --from requires start, --no-start skips, otherwise ask user
        let shouldStart = false
        if (restoreLocation) {
          shouldStart = true
        } else if (options.start === false) {
          shouldStart = false
        } else {
          console.log()
          shouldStart = await promptConfirm(`Start ${containerName} now?`, true)
        }

        const config = await containerManager.getConfig(containerName)

        if (shouldStart && config) {
          const startSpinner = createSpinner(
            `Starting ${dbEngine.displayName}...`,
          )
          startSpinner.start()

          try {
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

          const defaultDb = engineDefaults.superuser
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

        if (restoreLocation && restoreType && config && shouldStart) {
          let backupPath = ''

          if (restoreType === 'connection') {
            const timestamp = Date.now()
            tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}.dump`)

            let dumpSuccess = false
            let attempts = 0
            const maxAttempts = 2

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

                if (
                  e.message.includes('pg_dump not found') ||
                  e.message.includes('ENOENT')
                ) {
                  const installed = await promptInstallDependencies('pg_dump')
                  if (!installed) {
                    process.exit(1)
                  }
                  continue
                }

                console.log()
                console.error(error('pg_dump error:'))
                console.log(chalk.gray(`  ${e.message}`))
                process.exit(1)
              }
            }

            if (!dumpSuccess) {
              console.error(error('Failed to create dump after retries'))
              process.exit(1)
            }
          } else {
            backupPath = restoreLocation
          }

          const detectSpinner = createSpinner('Detecting backup format...')
          detectSpinner.start()

          const format = await dbEngine.detectBackupFormat(backupPath)
          detectSpinner.succeed(`Detected: ${format.description}`)

          const restoreSpinner = createSpinner('Restoring backup...')
          restoreSpinner.start()

          const result = await dbEngine.restore(config, backupPath, {
            database,
            createDatabase: false,
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

        tx.commit()

        const finalConfig = await containerManager.getConfig(containerName)
        if (finalConfig) {
          const connectionString = dbEngine.getConnectionString(finalConfig)

          console.log()
          console.log(
            connectionBox(containerName, connectionString, finalConfig.port),
          )
          console.log()

          if (shouldStart) {
            console.log(chalk.gray('  Connect with:'))
            console.log(chalk.cyan(`  spindb connect ${containerName}`))

            const copied =
              await platformService.copyToClipboard(connectionString)
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

        const missingToolPatterns = [
          'pg_restore not found',
          'psql not found',
          'pg_dump not found',
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
