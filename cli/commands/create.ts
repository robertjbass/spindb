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
import { header, uiError, connectionBox } from '../ui/theme'
import { tmpdir } from 'os'
import { join } from 'path'
import { getMissingDependencies } from '../../core/dependency-manager'
import { platformService } from '../../core/platform-service'
import { startWithRetry } from '../../core/start-with-retry'
import { TransactionManager } from '../../core/transaction-manager'
import { isValidDatabaseName } from '../../core/error-handler'
import { resolve } from 'path'
import { Engine } from '../../types'
import type { BaseEngine } from '../../engines/base-engine'

/**
 * Simplified SQLite container creation flow
 * SQLite is file-based, so no port, start/stop, or server management needed
 */
async function createSqliteContainer(
  containerName: string,
  dbEngine: BaseEngine,
  version: string,
  options: {
    path?: string
    from?: string | null
    connect?: boolean
    json?: boolean
  },
): Promise<void> {
  const { path: filePath, from: restoreLocation, connect, json } = options

  // Check dependencies
  const depsSpinner = json ? null : createSpinner('Checking required tools...')
  depsSpinner?.start()

  const missingDeps = await getMissingDependencies('sqlite')
  if (missingDeps.length > 0) {
    if (json) {
      console.log(JSON.stringify({ error: `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}` }))
      process.exit(1)
    }
    depsSpinner?.warn(
      `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
    )
    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      'sqlite',
    )
    if (!installed) {
      process.exit(1)
    }
  } else {
    depsSpinner?.succeed('Required tools available')
  }

  // Check if container already exists
  if (await containerManager.exists(containerName)) {
    if (json) {
      console.log(JSON.stringify({ error: `Container "${containerName}" already exists` }))
      process.exit(1)
    }
    while (await containerManager.exists(containerName)) {
      console.log(chalk.yellow(`  Container "${containerName}" already exists.`))
      containerName = await promptContainerName()
    }
  }

  // Determine file path
  const defaultPath = `./${containerName}.sqlite`
  const absolutePath = resolve(filePath || defaultPath)

  // Check if file already exists
  if (existsSync(absolutePath)) {
    if (json) {
      console.log(JSON.stringify({ error: `File already exists: ${absolutePath}` }))
    } else {
      console.error(uiError(`File already exists: ${absolutePath}`))
    }
    process.exit(1)
  }

  const createSpinnerInstance = json ? null : createSpinner('Creating SQLite database...')
  createSpinnerInstance?.start()

  try {
    // Initialize the SQLite database file and register in registry
    await dbEngine.initDataDir(containerName, version, { path: absolutePath })
    createSpinnerInstance?.succeed('SQLite database created')
  } catch (error) {
    createSpinnerInstance?.fail('Failed to create SQLite database')
    throw error
  }

  // Handle --from restore
  if (restoreLocation) {
    const config = await containerManager.getConfig(containerName)
    if (config) {
      const format = await dbEngine.detectBackupFormat(restoreLocation)
      const restoreSpinner = json ? null : createSpinner(
        `Restoring from ${format.description}...`,
      )
      restoreSpinner?.start()

      try {
        await dbEngine.restore(config, restoreLocation)
        restoreSpinner?.succeed('Backup restored successfully')
      } catch (error) {
        restoreSpinner?.fail('Failed to restore backup')
        // Clean up the created container on restore failure
        try {
          await containerManager.delete(containerName, { force: true })
        } catch {
          // Ignore cleanup errors - still throw the original restore error
        }
        throw error
      }
    }
  }

  const connectionString = `sqlite:///${absolutePath}`

  // Display success
  if (json) {
    console.log(
      JSON.stringify({
        success: true,
        name: containerName,
        engine: 'sqlite',
        version,
        path: absolutePath,
        database: containerName,
        connectionString,
        restored: !!restoreLocation,
      }),
    )
  } else {
    console.log()
    console.log(chalk.green('  ✓ SQLite database ready'))
    console.log()
    console.log(chalk.gray('  File path:'))
    console.log(chalk.cyan(`    ${absolutePath}`))
    console.log()
    console.log(chalk.gray('  Connection string:'))
    console.log(chalk.cyan(`    ${connectionString}`))
    console.log()

    if (connect) {
      const config = await containerManager.getConfig(containerName)
      if (config) {
        console.log(chalk.gray('  Opening shell...'))
        console.log()
        await dbEngine.connect(config)
      }
    } else {
      console.log(chalk.gray('  Connect with:'))
      console.log(chalk.cyan(`    spindb connect ${containerName}`))
      console.log()
    }
  }
}

/**
 * Simplified DuckDB container creation flow
 * DuckDB is file-based, so no port, start/stop, or server management needed
 */
async function createDuckDBContainer(
  containerName: string,
  dbEngine: BaseEngine,
  version: string,
  options: {
    path?: string
    from?: string | null
    connect?: boolean
    json?: boolean
  },
): Promise<void> {
  const { path: filePath, from: restoreLocation, connect, json } = options

  // Check dependencies
  const depsSpinner = json ? null : createSpinner('Checking required tools...')
  depsSpinner?.start()

  const missingDeps = await getMissingDependencies('duckdb')
  if (missingDeps.length > 0) {
    if (json) {
      console.log(JSON.stringify({ error: `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}` }))
      process.exit(1)
    }
    depsSpinner?.warn(
      `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
    )
    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      'duckdb',
    )
    if (!installed) {
      process.exit(1)
    }
  } else {
    depsSpinner?.succeed('Required tools available')
  }

  // Check if container already exists
  if (await containerManager.exists(containerName)) {
    if (json) {
      console.log(JSON.stringify({ error: `Container "${containerName}" already exists` }))
      process.exit(1)
    }
    while (await containerManager.exists(containerName)) {
      console.log(chalk.yellow(`  Container "${containerName}" already exists.`))
      containerName = await promptContainerName()
    }
  }

  // Determine file path
  const defaultPath = `./${containerName}.duckdb`
  const absolutePath = resolve(filePath || defaultPath)

  // Check if file already exists
  if (existsSync(absolutePath)) {
    if (json) {
      console.log(JSON.stringify({ error: `File already exists: ${absolutePath}` }))
    } else {
      console.error(uiError(`File already exists: ${absolutePath}`))
    }
    process.exit(1)
  }

  const createSpinnerInstance = json ? null : createSpinner('Creating DuckDB database...')
  createSpinnerInstance?.start()

  try {
    // Initialize the DuckDB database file and register in registry
    await dbEngine.initDataDir(containerName, version, { path: absolutePath })
    createSpinnerInstance?.succeed('DuckDB database created')
  } catch (error) {
    createSpinnerInstance?.fail('Failed to create DuckDB database')
    throw error
  }

  // Handle --from restore
  if (restoreLocation) {
    const config = await containerManager.getConfig(containerName)
    if (config) {
      const format = await dbEngine.detectBackupFormat(restoreLocation)
      const restoreSpinner = json ? null : createSpinner(
        `Restoring from ${format.description}...`,
      )
      restoreSpinner?.start()

      try {
        await dbEngine.restore(config, restoreLocation)
        restoreSpinner?.succeed('Backup restored successfully')
      } catch (error) {
        restoreSpinner?.fail('Failed to restore backup')
        // Clean up the created container on restore failure
        try {
          await containerManager.delete(containerName, { force: true })
        } catch {
          // Ignore cleanup errors - still throw the original restore error
        }
        throw error
      }
    }
  }

  const connectionString = `duckdb:///${absolutePath}`

  // Display success
  if (json) {
    console.log(
      JSON.stringify({
        success: true,
        name: containerName,
        engine: 'duckdb',
        version,
        path: absolutePath,
        database: containerName,
        connectionString,
        restored: !!restoreLocation,
      }),
    )
  } else {
    console.log()
    console.log(chalk.green('  ✓ DuckDB database ready'))
    console.log()
    console.log(chalk.gray('  File path:'))
    console.log(chalk.cyan(`    ${absolutePath}`))
    console.log()
    console.log(chalk.gray('  Connection string:'))
    console.log(chalk.cyan(`    ${connectionString}`))
    console.log()

    if (connect) {
      const config = await containerManager.getConfig(containerName)
      if (config) {
        console.log(chalk.gray('  Opening shell...'))
        console.log()
        await dbEngine.connect(config)
      }
    } else {
      console.log(chalk.gray('  Connect with:'))
      console.log(chalk.cyan(`    spindb connect ${containerName}`))
      console.log()
    }
  }
}

export function detectLocationType(location: string): {
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

  if (location.startsWith('sqlite://')) {
    return { type: 'connection', inferredEngine: Engine.SQLite }
  }

  if (location.startsWith('duckdb://')) {
    return { type: 'connection', inferredEngine: Engine.DuckDB }
  }

  if (location.startsWith('redis://') || location.startsWith('rediss://')) {
    return { type: 'connection', inferredEngine: Engine.Redis }
  }

  if (location.startsWith('valkey://') || location.startsWith('valkeys://')) {
    return { type: 'connection', inferredEngine: Engine.Valkey }
  }

  if (existsSync(location)) {
    // Check if it's a SQLite file (case-insensitive)
    const lowerLocation = location.toLowerCase()
    if (
      lowerLocation.endsWith('.sqlite') ||
      lowerLocation.endsWith('.sqlite3')
    ) {
      return { type: 'file', inferredEngine: Engine.SQLite }
    }
    // Check if it's a DuckDB file (case-insensitive)
    // Note: We don't infer DuckDB from '.db' extension because it's commonly used by SQLite
    if (lowerLocation.endsWith('.duckdb') || lowerLocation.endsWith('.ddb')) {
      return { type: 'file', inferredEngine: Engine.DuckDB }
    }
    return { type: 'file' }
  }

  return { type: 'not_found' }
}

export const createCommand = new Command('create')
  .description('Create a new database container')
  .argument('[name]', 'Container name')
  .option(
    '-e, --engine <engine>',
    'Database engine (postgresql, mysql, mariadb, sqlite, duckdb, mongodb, redis, valkey)',
  )
  .option('--db-version <version>', 'Database version (e.g., 17, 8.0)')
  .option('-d, --database <database>', 'Database name')
  .option('-p, --port <port>', 'Port number')
  .option(
    '--path <path>',
    'Path for SQLite/DuckDB database file (default: ./<name>.sqlite or ./<name>.duckdb)',
  )
  .option(
    '--max-connections <number>',
    'Maximum number of database connections (default: 200)',
  )
  .option('--start', 'Start the container after creation (skip prompt)')
  .option('--no-start', 'Do not start the container after creation')
  .option('--connect', 'Open a shell connection after creation')
  .option(
    '--from <location>',
    'Restore from a dump file or connection string after creation',
  )
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (
      name: string | undefined,
      options: {
        engine?: string
        dbVersion?: string
        database?: string
        port?: string
        path?: string
        maxConnections?: string
        start?: boolean
        connect?: boolean
        from?: string
        json?: boolean
      },
    ) => {
      let tempDumpPath: string | null = null

      try {
        let containerName = name
        let engine: Engine = (options.engine as Engine) || Engine.PostgreSQL
        let version = options.dbVersion
        let database = options.database

        let restoreLocation: string | null = null
        let restoreType: 'connection' | 'file' | null = null

        if (options.from) {
          const locationInfo = detectLocationType(options.from)

          if (locationInfo.type === 'not_found') {
            if (options.json) {
              console.log(JSON.stringify({ error: `Location not found: ${options.from}` }))
            } else {
              console.error(uiError(`Location not found: ${options.from}`))
              console.log(
                chalk.gray(
                  '  Provide a valid file path or connection string:',
                ),
              )
              console.log(
                chalk.gray(
                  '  postgresql://, mysql://, mongodb://, redis://, sqlite://, duckdb://',
                ),
              )
            }
            process.exit(1)
          }

          restoreLocation = options.from
          restoreType = locationInfo.type

          if (!options.engine && locationInfo.inferredEngine) {
            engine = locationInfo.inferredEngine
            if (!options.json) {
              console.log(
                chalk.gray(
                  `  Inferred engine "${engine}" from connection string`,
                ),
              )
            }
          }

          if (options.start === false) {
            if (options.json) {
              console.log(JSON.stringify({ error: 'Cannot use --no-start with --from (restore requires running container)' }))
            } else {
              console.error(
                uiError(
                  'Cannot use --no-start with --from (restore requires running container)',
                ),
              )
            }
            process.exit(1)
          }
        }

        const engineDefaults = getEngineDefaults(engine)

        if (!version) {
          version = engineDefaults.defaultVersion
        }

        if (!containerName) {
          // JSON mode requires container name argument
          if (options.json) {
            console.log(JSON.stringify({ error: 'Container name is required' }))
            process.exit(1)
          }

          const answers = await promptCreateOptions()
          containerName = answers.name
          engine = answers.engine as Engine
          version = answers.version
          database = answers.database
        }

        // Redis/Valkey use numbered databases (0-15), default to "0"
        // Other engines default to container name (with hyphens replaced by underscores for SQL compatibility)
        if (engine === Engine.Redis || engine === Engine.Valkey) {
          database = database ?? '0'
          // Validate Redis/Valkey database is a pure integer string 0-15
          // Reject decimals ("1.5"), scientific notation ("1e2"), and trailing garbage ("5abc")
          if (!/^[0-9]+$/.test(database)) {
            const errorMsg = 'Redis/Valkey database must be an integer between 0 and 15'
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
          const dbIndex = parseInt(database, 10)
          if (dbIndex < 0 || dbIndex > 15) {
            const errorMsg = 'Redis/Valkey database must be an integer between 0 and 15'
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        } else {
          database = database ?? containerName.replace(/-/g, '_')
          // Validate database name to prevent SQL injection
          if (!isValidDatabaseName(database)) {
            const errorMsg = 'Database name must start with a letter and contain only letters, numbers, and underscores'
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        if (!options.json) {
          console.log(header('Creating Database Container'))
          console.log()
        }

        const dbEngine = getEngine(engine)
        const isPostgreSQL = engine === Engine.PostgreSQL

        // SQLite has a simplified flow (no port, no start/stop)
        if (engine === Engine.SQLite) {
          await createSqliteContainer(containerName, dbEngine, version, {
            path: options.path,
            from: restoreLocation,
            connect: options.connect,
            json: options.json,
          })
          return
        }

        // DuckDB has a simplified flow (no port, no start/stop)
        if (engine === Engine.DuckDB) {
          await createDuckDBContainer(containerName, dbEngine, version, {
            path: options.path,
            from: restoreLocation,
            connect: options.connect,
            json: options.json,
          })
          return
        }

        // For server databases, validate --connect with --no-start
        if (options.connect && options.start === false) {
          const errorMsg = 'Cannot use --no-start with --connect (connection requires running container)'
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // In JSON mode, require explicit --start or --no-start flag to avoid interactive prompts
        if (options.json && options.start === undefined && !restoreLocation && !options.connect) {
          const errorMsg = 'In JSON mode, you must specify --start or --no-start for server databases'
          console.log(JSON.stringify({ error: errorMsg }))
          process.exit(1)
        }

        // Validate --max-connections if provided
        if (options.maxConnections) {
          const parsed = parseInt(options.maxConnections, 10)
          if (!Number.isFinite(parsed) || parsed <= 0) {
            const errorMsg = 'Invalid --max-connections value: must be a positive integer'
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        const portSpinner = options.json ? null : createSpinner('Finding available port...')
        portSpinner?.start()

        let port: number
        if (options.port) {
          port = parseInt(options.port, 10)
          const available = await portManager.isPortAvailable(port)
          if (!available) {
            if (options.json) {
              console.log(JSON.stringify({ error: `Port ${port} is already in use` }))
            } else {
              portSpinner?.fail(`Port ${port} is already in use`)
            }
            process.exit(1)
          }
          portSpinner?.succeed(`Using port ${port}`)
        } else {
          const { port: foundPort, isDefault } =
            await portManager.findAvailablePort({
              preferredPort: engineDefaults.defaultPort,
              portRange: engineDefaults.portRange,
            })
          port = foundPort
          if (isDefault) {
            portSpinner?.succeed(`Using default port ${port}`)
          } else {
            portSpinner?.warn(
              `Default port ${engineDefaults.defaultPort} is in use, using port ${port}`,
            )
          }
        }

        // For PostgreSQL, ensure binaries FIRST - they include client tools (psql, pg_dump, etc.)
        // ensureBinaries also registers tool paths in config cache so getMissingDependencies can find them
        if (isPostgreSQL) {
          const binarySpinner = options.json
            ? null
            : createSpinner(`Checking ${dbEngine.displayName} ${version} binaries...`)
          binarySpinner?.start()

          // Always call ensureBinaries - it handles cached binaries gracefully
          // and registers client tool paths in config (needed for dependency checks)
          await dbEngine.ensureBinaries(version, ({ stage, message }) => {
            if (binarySpinner) {
              if (stage === 'cached') {
                binarySpinner.text = `${dbEngine.displayName} ${version} binaries ready (cached)`
              } else {
                binarySpinner.text = message
              }
            }
          })
          binarySpinner?.succeed(`${dbEngine.displayName} ${version} binaries ready`)
        }

        // Check dependencies (all engines need this)
        // For PostgreSQL, this runs AFTER binary download so client tools are available
        const depsSpinner = options.json ? null : createSpinner('Checking required tools...')
        depsSpinner?.start()

        let missingDeps = await getMissingDependencies(engine)
        if (missingDeps.length > 0) {
          // In JSON mode, error out instead of prompting
          if (options.json) {
            console.log(JSON.stringify({
              error: `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
            }))
            process.exit(1)
          }

          depsSpinner?.warn(
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
              uiError(
                `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
              ),
            )
            process.exit(1)
          }

          console.log(chalk.green('  ✓ All required tools are now available'))
          console.log()
        } else {
          depsSpinner?.succeed('Required tools available')
        }

        // For non-PostgreSQL engines, validate version and get binary path
        // Store the binary path for version consistency
        let binaryPath: string | undefined
        if (!isPostgreSQL) {
          const binarySpinner = options.json
            ? null
            : createSpinner(`Checking ${dbEngine.displayName} ${version} binaries...`)
          binarySpinner?.start()

          try {
            // ensureBinaries validates the version and returns the binary path
            binaryPath = await dbEngine.ensureBinaries(
              version,
              ({ message }) => {
                if (binarySpinner) {
                  binarySpinner.text = message
                }
              },
            )
            binarySpinner?.succeed(`${dbEngine.displayName} ${version} binaries ready`)
          } catch (error) {
            if (options.json) {
              console.log(JSON.stringify({
                error: `${dbEngine.displayName} ${version} not available`,
              }))
              process.exit(1)
            }
            binarySpinner?.fail(`${dbEngine.displayName} ${version} not available`)
            throw error
          }
        }

        if (await containerManager.exists(containerName)) {
          if (options.json) {
            console.log(JSON.stringify({
              error: `Container "${containerName}" already exists`,
            }))
            process.exit(1)
          }
          while (await containerManager.exists(containerName)) {
            console.log(
              chalk.yellow(`  Container "${containerName}" already exists.`),
            )
            containerName = await promptContainerName()
          }
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
            binaryPath,
          })

          tx.addRollback({
            description: `Delete container "${containerName}"`,
            execute: async () => {
              await containerManager.delete(containerName, { force: true })
            },
          })

          createSpinnerInstance.succeed('Container created')
        } catch (error) {
          createSpinnerInstance.fail('Failed to create container')
          throw error
        }

        const initSpinner = createSpinner('Initializing database cluster...')
        initSpinner.start()

        try {
          await dbEngine.initDataDir(containerName, version, {
            port,
            superuser: engineDefaults.superuser,
            maxConnections: options.maxConnections
              ? parseInt(options.maxConnections, 10)
              : undefined,
          })
          initSpinner.succeed('Database cluster initialized')
        } catch (error) {
          initSpinner.fail('Failed to initialize database cluster')
          await tx.rollback()
          throw error
        }

        // --from requires start, --start forces start, --no-start skips, otherwise ask user
        // --connect implies --start for server databases
        let shouldStart = false
        if (restoreLocation || options.connect) {
          shouldStart = true
        } else if (options.start === true) {
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
          } catch (error) {
            if (!startSpinner.isSpinning) {
              // Error was already handled above
            } else {
              startSpinner.fail(`Failed to start ${dbEngine.displayName}`)
            }
            await tx.rollback()
            throw error
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
            } catch (error) {
              dbSpinner.fail(`Failed to create database "${database}"`)
              await tx.rollback()
              throw error
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
                const dumpResult = await dbEngine.dumpFromConnectionString(
                  restoreLocation,
                  tempDumpPath,
                )
                dumpSpinner.succeed('Dump created from remote database')
                if (dumpResult.warnings?.length) {
                  for (const warning of dumpResult.warnings) {
                    console.log(chalk.yellow(`  ${warning}`))
                  }
                }
                backupPath = tempDumpPath
                dumpSuccess = true
              } catch (error) {
                const e = error as Error
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
                console.error(uiError('pg_dump error:'))
                console.log(chalk.gray(`  ${e.message}`))
                process.exit(1)
              }
            }

            if (!dumpSuccess) {
              console.error(uiError('Failed to create dump after retries'))
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

          if (result.code === 0) {
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

          if (options.json) {
            console.log(
              JSON.stringify({
                success: true,
                name: containerName,
                engine: finalConfig.engine,
                version: finalConfig.version,
                port: finalConfig.port,
                database,
                connectionString,
                status: finalConfig.status,
                restored: !!restoreLocation,
              }),
            )
          } else {
            console.log()
            console.log(
              connectionBox(containerName, connectionString, finalConfig.port),
            )
            console.log()

            if (options.connect && shouldStart) {
              // --connect flag: open shell directly
              const copied =
                await platformService.copyToClipboard(connectionString)
              if (copied) {
                console.log(
                  chalk.gray('  Connection string copied to clipboard'),
                )
              }
              console.log(chalk.gray('  Opening shell...'))
              console.log()
              await dbEngine.connect(finalConfig, database)
            } else if (shouldStart) {
              console.log(chalk.gray('  Connect with:'))
              console.log(chalk.cyan(`  spindb connect ${containerName}`))

              const copied =
                await platformService.copyToClipboard(connectionString)
              if (copied) {
                console.log(
                  chalk.gray('  Connection string copied to clipboard'),
                )
              }
              console.log()
            } else {
              console.log(chalk.gray('  Start the container:'))
              console.log(chalk.cyan(`  spindb start ${containerName}`))
              console.log()
            }
          }
        }
      } catch (error) {
        const e = error as Error

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
          if (options.json) {
            console.log(JSON.stringify({ error: e.message }))
            process.exit(1)
          }
          const missingTool = matchingPattern.replace(' not found', '')
          const installed = await promptInstallDependencies(missingTool)
          if (installed) {
            console.log(
              chalk.yellow('  Please re-run your command to continue.'),
            )
          }
          process.exit(1)
        }

        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
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
