import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { mkdir, stat, unlink } from 'fs/promises'
import { join } from 'path'
import {
  containerManager,
  updateRenameTracking,
} from '../../core/container-manager'
import { uiError, uiSuccess, uiWarning } from '../ui/theme'
import { getEngineMetadata } from '../helpers'
import { getEngine } from '../../engines'
import { isRemoteContainer } from '../../types'
import {
  canCreateDatabase,
  canDropDatabase,
  canRenameDatabase,
  getDatabaseCapabilities,
  getUnsupportedCreateMessage,
  getUnsupportedDropMessage,
  getUnsupportedRenameMessage,
} from '../../core/database-capabilities'
import { createSpinner } from '../ui/spinner'
import { paths } from '../../config/paths'
import {
  getDefaultFormat,
  getBackupExtension,
} from '../../config/backup-formats'
import { isInteractiveMode } from '../../core/error-handler'

/**
 * CLI command for managing databases within containers.
 *
 * Includes:
 * - create/drop/rename: Perform real database operations on running containers
 * - list/add/remove/sync/refresh/set-default: Manage database tracking metadata
 */
export const databasesCommand = new Command('databases').description(
  'Manage databases within a container',
)

// List databases in a container (or all containers if none specified)
databasesCommand
  .command('list')
  .description('List tracked databases in a container (or all containers)')
  .argument('[container]', 'Container name (optional - lists all if omitted)')
  .option('-j, --json', 'Output as JSON')
  .option('--default', 'Show only the default database (requires container)')
  .action(
    async (
      container: string | undefined,
      options: { json?: boolean; default?: boolean },
    ) => {
      try {
        // --default requires a container
        if (options.default && !container) {
          const errorMsg = '--default requires a container name'
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // If no container specified, list all containers with their databases
        if (!container) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            if (options.json) {
              console.log(JSON.stringify([], null, 2))
            } else {
              console.log()
              console.log(chalk.gray('No containers found.'))
              console.log()
            }
            return
          }

          if (options.json) {
            const result = await Promise.all(
              containers.map(async (c) => {
                const rawDatabases = c.databases || []
                const databases = [...new Set([c.database, ...rawDatabases])]
                const metadata = await getEngineMetadata(c.engine)
                return {
                  container: c.name,
                  engine: c.engine,
                  primary: c.database,
                  databases,
                  ...metadata,
                }
              }),
            )
            console.log(JSON.stringify(result, null, 2))
          } else {
            console.log()
            for (const c of containers) {
              const rawDatabases = c.databases || []
              const databases = [...new Set([c.database, ...rawDatabases])]
              console.log(
                chalk.bold(`${c.name}`) + chalk.gray(` (${c.engine})`),
              )
              for (const db of databases) {
                const isPrimary = db === c.database
                const label = isPrimary ? chalk.gray(' (primary)') : ''
                console.log(`  ${chalk.cyan(db)}${label}`)
              }
              console.log()
            }
          }
          return
        }

        // Single container specified
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `Container "${container}" not found` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`Container "${container}" not found`))
          }
          process.exit(1)
        }

        // --default flag: just output the default database name
        if (options.default) {
          if (options.json) {
            console.log(JSON.stringify({ database: config.database }, null, 2))
          } else {
            console.log(config.database)
          }
          return
        }

        // Merge config.databases with config.database to ensure primary is always included
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]

        if (options.json) {
          const metadata = await getEngineMetadata(config.engine)
          console.log(JSON.stringify({ ...config, ...metadata }, null, 2))
        } else {
          console.log()
          console.log(chalk.bold(`Databases in "${container}":`))
          for (const db of databases) {
            const isPrimary = db === config.database
            const label = isPrimary ? chalk.gray(' (primary)') : ''
            console.log(`  ${chalk.cyan(db)}${label}`)
          }
          console.log()
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// Add a database to tracking
databasesCommand
  .command('add')
  .description(
    'Add a database to tracking (does not create the actual database)',
  )
  .argument('<container>', 'Container name')
  .argument('<database>', 'Database name to add')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      container: string,
      database: string,
      options: { json?: boolean },
    ) => {
      try {
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `Container "${container}" not found` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`Container "${container}" not found`))
          }
          process.exit(1)
        }

        // Merge config.databases with config.database to ensure primary is always included
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]
        if (databases.includes(database)) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  message: `Database "${database}" is already tracked`,
                  databases,
                },
                null,
                2,
              ),
            )
          } else {
            console.log(
              chalk.gray(
                `Database "${database}" is already tracked in "${container}"`,
              ),
            )
          }
          return
        }

        await containerManager.addDatabase(container, database)
        const updatedConfig = await containerManager.getConfig(container)
        const updatedDatabases = updatedConfig?.databases || []

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                added: database,
                databases: updatedDatabases,
              },
              null,
              2,
            ),
          )
        } else {
          console.log(
            uiSuccess(`Added "${database}" to tracking in "${container}"`),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// Remove a database from tracking
databasesCommand
  .command('remove')
  .description(
    'Remove a database from tracking (does not drop the actual database)',
  )
  .argument('<container>', 'Container name')
  .argument('<database>', 'Database name to remove')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      container: string,
      database: string,
      options: { json?: boolean },
    ) => {
      try {
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `Container "${container}" not found` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`Container "${container}" not found`))
          }
          process.exit(1)
        }

        // Check if trying to remove primary database
        if (database === config.database) {
          const errorMsg = `Cannot remove primary database "${database}" from tracking`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // Merge config.databases with config.database to ensure primary is always included
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]
        if (!databases.includes(database)) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  message: `Database "${database}" is not tracked`,
                  databases,
                },
                null,
                2,
              ),
            )
          } else {
            console.log(
              chalk.gray(
                `Database "${database}" is not tracked in "${container}"`,
              ),
            )
          }
          return
        }

        await containerManager.removeDatabase(container, database)
        const updatedConfig = await containerManager.getConfig(container)
        const updatedDatabases = updatedConfig?.databases || []

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                removed: database,
                databases: updatedDatabases,
              },
              null,
              2,
            ),
          )
        } else {
          console.log(
            uiSuccess(`Removed "${database}" from tracking in "${container}"`),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// Sync command - update tracking after rename operations
databasesCommand
  .command('sync')
  .description('Sync tracking after database rename (removes old, adds new)')
  .argument('<container>', 'Container name')
  .argument('<old-name>', 'Old database name to remove from tracking')
  .argument('<new-name>', 'New database name to add to tracking')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      container: string,
      oldName: string,
      newName: string,
      options: { json?: boolean },
    ) => {
      try {
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `Container "${container}" not found` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`Container "${container}" not found`))
          }
          process.exit(1)
        }

        // Cannot sync if old name is the primary database
        if (oldName === config.database) {
          const errorMsg = `Cannot sync primary database "${oldName}". Use 'spindb edit' to change the primary database.`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // No-op if old and new names are the same
        if (oldName === newName) {
          const errorMsg = `Old and new database names are the same: "${oldName}"`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // Add new name first (in case old name doesn't exist in tracking)
        await containerManager.addDatabase(container, newName)

        // Remove old name if it was tracked
        // Merge config.databases with config.database to ensure primary is always included
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]
        const wasTracked = databases.includes(oldName)
        if (wasTracked) {
          await containerManager.removeDatabase(container, oldName)
        }

        const updatedConfig = await containerManager.getConfig(container)
        const updatedDatabases = updatedConfig?.databases || []

        if (options.json) {
          const result: Record<string, unknown> = {
            success: true,
            added: newName,
            databases: updatedDatabases,
          }
          // Only include 'removed' if the old name was actually tracked
          if (wasTracked) {
            result.removed = oldName
          }
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log(
            uiSuccess(
              `Synced database rename: "${oldName}" -> "${newName}" in "${container}"`,
            ),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// Refresh databases from server - queries the actual database server
databasesCommand
  .command('refresh')
  .description(
    'Refresh tracking by querying the database server for actual databases',
  )
  .argument('<container>', 'Container name')
  .option('-j, --json', 'Output as JSON')
  .action(async (container: string, options: { json?: boolean }) => {
    try {
      const config = await containerManager.getConfig(container)
      if (!config) {
        if (options.json) {
          console.log(
            JSON.stringify(
              { error: `Container "${container}" not found` },
              null,
              2,
            ),
          )
        } else {
          console.error(uiError(`Container "${container}" not found`))
        }
        process.exit(1)
      }

      const beforeDatabases = config.databases || [config.database]
      const afterDatabases = await containerManager.syncDatabases(container)

      // Calculate changes
      const added = afterDatabases.filter((db) => !beforeDatabases.includes(db))
      const removed = beforeDatabases.filter(
        (db) => !afterDatabases.includes(db),
      )

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              success: true,
              container,
              databases: afterDatabases,
              changes: {
                added: added.length > 0 ? added : undefined,
                removed: removed.length > 0 ? removed : undefined,
              },
            },
            null,
            2,
          ),
        )
      } else {
        if (added.length === 0 && removed.length === 0) {
          console.log(chalk.gray(`Registry already in sync for "${container}"`))
        } else {
          console.log(
            uiSuccess(`Refreshed database tracking for "${container}"`),
          )
          if (added.length > 0) {
            console.log(chalk.green(`  Added: ${added.join(', ')}`))
          }
          if (removed.length > 0) {
            console.log(chalk.yellow(`  Removed: ${removed.join(', ')}`))
          }
        }
        console.log()
        console.log(chalk.bold('Current databases:'))
        for (const db of afterDatabases) {
          const isPrimary = db === config.database
          const label = isPrimary ? chalk.gray(' (primary)') : ''
          console.log(`  ${chalk.cyan(db)}${label}`)
        }
      }
    } catch (error) {
      const e = error as Error
      if (options.json) {
        console.log(JSON.stringify({ error: e.message }, null, 2))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })

// Set the default/primary database for a container
databasesCommand
  .command('set-default')
  .description('Set the default (primary) database for a container')
  .argument('<container>', 'Container name')
  .argument('<database>', 'Database name to set as default')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      container: string,
      database: string,
      options: { json?: boolean },
    ) => {
      try {
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { error: `Container "${container}" not found` },
                null,
                2,
              ),
            )
          } else {
            console.error(uiError(`Container "${container}" not found`))
          }
          process.exit(1)
        }

        // Check if database is tracked
        const rawDatabases = config.databases || []
        const databases = [...new Set([config.database, ...rawDatabases])]
        if (!databases.includes(database)) {
          const errorMsg = `Database "${database}" is not tracked in "${container}". Add it first with: spindb databases add ${container} ${database}`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // Check if already the default
        if (database === config.database) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  message: `Database "${database}" is already the default`,
                  primary: database,
                  databases,
                },
                null,
                2,
              ),
            )
          } else {
            console.log(
              chalk.gray(
                `Database "${database}" is already the default in "${container}"`,
              ),
            )
          }
          return
        }

        // Update the primary database
        await containerManager.updateConfig(container, { database })

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                primary: database,
                previous: config.database,
                databases,
              },
              null,
              2,
            ),
          )
        } else {
          console.log(
            uiSuccess(
              `Default database changed from "${config.database}" to "${database}" in "${container}"`,
            ),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// ─────────────────────────────────────────────────────────────────────────────
// Real database operations (create, drop, rename)
// These perform actual database operations on running containers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper: output an error in the appropriate format and exit
 */
function outputError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }, null, 2))
  } else {
    console.error(uiError(message))
  }
  process.exit(1)
}

/**
 * Helper: validate common preconditions for database operations
 */
async function validateContainer(
  containerName: string,
  options: { json?: boolean; requireRunning?: boolean },
) {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    outputError(`Container "${containerName}" not found`, options.json)
  }

  if (isRemoteContainer(config)) {
    outputError(
      `Database operations are not supported for linked/remote containers. Use your database provider's tools instead.`,
      options.json,
    )
  }

  if (options.requireRunning && config.status !== 'running') {
    outputError(
      `Container "${containerName}" is not running. Start it first with: spindb start ${containerName}`,
      options.json,
    )
  }

  return config
}

// Create a new database within a running container
databasesCommand
  .command('create')
  .description('Create a new database within a running container')
  .argument('<container>', 'Container name')
  .argument('[database]', 'Database name (prompted interactively if omitted)')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      containerName: string,
      database: string | undefined,
      options: { json?: boolean },
    ) => {
      try {
        const config = await validateContainer(containerName, {
          json: options.json,
          requireRunning: true,
        })

        if (!canCreateDatabase(config.engine)) {
          outputError(getUnsupportedCreateMessage(config.engine), options.json)
        }

        // Require database arg in JSON mode (no interactive prompts)
        if (!database && options.json) {
          outputError('Database name is required in --json mode', options.json)
        }

        // Prompt for database name if not provided
        if (!database) {
          if (!isInteractiveMode()) {
            outputError(
              'Database name is required in non-interactive mode. Usage: spindb databases create <container> <database>',
              options.json,
            )
          }
          const { dbName } = await inquirer.prompt<{ dbName: string }>([
            {
              type: 'input',
              name: 'dbName',
              message: 'Database name:',
              validate: (input: string) => {
                if (!input.trim()) return 'Database name is required'
                if (/\s/.test(input))
                  return 'Database name cannot contain spaces'
                return true
              },
            },
          ])
          database = dbName
        }

        // Check if database already exists in tracking
        const rawDatabases = config.databases || []
        const trackedDatabases = [
          ...new Set([config.database, ...rawDatabases]),
        ]
        if (trackedDatabases.includes(database)) {
          outputError(
            `Database "${database}" already exists in "${containerName}"`,
            options.json,
          )
        }

        // Check if database exists on the server
        const engine = getEngine(config.engine)
        try {
          const serverDatabases = await engine.listDatabases(config)
          if (serverDatabases.includes(database)) {
            outputError(
              `Database "${database}" already exists on the server. Use "spindb databases add ${containerName} ${database}" to track it.`,
              options.json,
            )
          }
        } catch {
          // listDatabases may not be supported; proceed anyway
        }

        // Create the database
        if (!options.json) {
          const spinner = createSpinner(
            `Creating database "${database}" in "${containerName}"...`,
          )
          spinner.start()
          try {
            await engine.createDatabase(config, database)
            spinner.succeed(
              `Created database "${database}" in "${containerName}"`,
            )
          } catch (error) {
            spinner.fail(`Failed to create database "${database}"`)
            throw error
          }
        } else {
          await engine.createDatabase(config, database)
        }

        // Track the new database
        await containerManager.addDatabase(containerName, database)

        // Get connection string
        const connectionString = engine.getConnectionString(config, database)

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                container: containerName,
                engine: config.engine,
                database,
                connectionString,
              },
              null,
              2,
            ),
          )
        } else {
          console.log(
            chalk.gray(`  Connection: ${chalk.white(connectionString)}`),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// Drop a database from a running container
databasesCommand
  .command('drop')
  .description('Drop a database from a running container (with confirmation)')
  .argument('<container>', 'Container name')
  .argument('[database]', 'Database name (selected interactively if omitted)')
  .option('-j, --json', 'Output as JSON')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(
    async (
      containerName: string,
      database: string | undefined,
      options: { json?: boolean; force?: boolean },
    ) => {
      try {
        const config = await validateContainer(containerName, {
          json: options.json,
          requireRunning: true,
        })

        if (!canDropDatabase(config.engine)) {
          outputError(getUnsupportedDropMessage(config.engine), options.json)
        }

        // Require database arg in JSON mode
        if (!database && options.json) {
          outputError('Database name is required in --json mode', options.json)
        }

        // Build list of droppable databases (exclude primary)
        const rawDatabases = config.databases || []
        const trackedDatabases = [
          ...new Set([config.database, ...rawDatabases]),
        ]
        const droppable = trackedDatabases.filter(
          (db) => db !== config.database,
        )

        // Prompt for database name if not provided
        if (!database) {
          if (droppable.length === 0) {
            outputError(
              `No databases to drop in "${containerName}". The primary database cannot be dropped.`,
              options.json,
            )
          }

          if (!isInteractiveMode()) {
            outputError(
              'Database name is required in non-interactive mode. Usage: spindb databases drop <container> <database>',
              options.json,
            )
          }

          const { dbName } = await inquirer.prompt<{ dbName: string }>([
            {
              type: 'list',
              name: 'dbName',
              message: 'Select database to drop:',
              choices: droppable.map((db) => ({ name: db, value: db })),
            },
          ])
          database = dbName
        }

        // Block dropping the primary database
        if (database === config.database) {
          outputError(
            `Cannot drop the primary database "${database}". Use "spindb delete ${containerName}" to remove the entire container.`,
            options.json,
          )
        }

        // Confirm unless --force
        if (!options.force && !options.json) {
          if (!isInteractiveMode()) {
            outputError(
              `Dropping a database is destructive. Use --force to skip confirmation in non-interactive mode.`,
              options.json,
            )
          }
          const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
            {
              type: 'confirm',
              name: 'confirm',
              message: `Drop database "${database}" from ${config.engine} container "${containerName}"? This cannot be undone.`,
              default: false,
            },
          ])
          if (!confirm) {
            console.log(chalk.gray('Cancelled.'))
            return
          }
        }

        const engine = getEngine(config.engine)

        // Terminate connections and drop
        if (!options.json) {
          const spinner = createSpinner(
            `Dropping database "${database}" from "${containerName}"...`,
          )
          spinner.start()
          try {
            await engine.terminateConnections(config, database)
            await engine.dropDatabase(config, database)
            spinner.succeed(
              `Dropped database "${database}" from "${containerName}"`,
            )
          } catch (error) {
            spinner.fail(`Failed to drop database "${database}"`)
            throw error
          }
        } else {
          await engine.terminateConnections(config, database)
          await engine.dropDatabase(config, database)
        }

        // Remove from tracking
        await containerManager.removeDatabase(containerName, database)

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                container: containerName,
                engine: config.engine,
                dropped: database,
              },
              null,
              2,
            ),
          )
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// Rename a database within a running container
databasesCommand
  .command('rename')
  .description('Rename a database within a running container')
  .argument('<container>', 'Container name')
  .argument('[old-name]', 'Current database name')
  .argument('[new-name]', 'New database name')
  .option('-j, --json', 'Output as JSON')
  .option(
    '--backup',
    'Force backup/restore path even for native-rename engines',
  )
  .option('--no-drop', 'Keep the old database after copying data to new name')
  .action(
    async (
      containerName: string,
      oldName: string | undefined,
      newName: string | undefined,
      options: { json?: boolean; backup?: boolean; drop?: boolean },
    ) => {
      try {
        const config = await validateContainer(containerName, {
          json: options.json,
          requireRunning: true,
        })

        if (!canRenameDatabase(config.engine)) {
          outputError(getUnsupportedRenameMessage(config.engine), options.json)
        }

        // Require both args in JSON mode
        if ((!oldName || !newName) && options.json) {
          outputError(
            'Both old-name and new-name are required in --json mode',
            options.json,
          )
        }

        // Build list of renameable databases
        const rawDatabases = config.databases || []
        const trackedDatabases = [
          ...new Set([config.database, ...rawDatabases]),
        ]

        // Prompt for old name if not provided
        if (!oldName) {
          if (trackedDatabases.length === 0) {
            outputError(
              `No databases to rename in "${containerName}".`,
              options.json,
            )
          }

          if (!isInteractiveMode()) {
            outputError(
              'Database names are required in non-interactive mode. Usage: spindb databases rename <container> <old> <new>',
              options.json,
            )
          }

          const { dbName } = await inquirer.prompt<{ dbName: string }>([
            {
              type: 'list',
              name: 'dbName',
              message: 'Select database to rename:',
              choices: trackedDatabases.map((db) => {
                const isPrimary = db === config.database
                return {
                  name: isPrimary ? `${db} (primary)` : db,
                  value: db,
                }
              }),
            },
          ])
          oldName = dbName
        }

        // Prompt for new name if not provided
        if (!newName) {
          if (!isInteractiveMode()) {
            outputError(
              'New database name is required in non-interactive mode. Usage: spindb databases rename <container> <old> <new>',
              options.json,
            )
          }

          const { dbName } = await inquirer.prompt<{ dbName: string }>([
            {
              type: 'input',
              name: 'dbName',
              message: `New name for "${oldName}":`,
              validate: (input: string) => {
                if (!input.trim()) return 'Database name is required'
                if (/\s/.test(input))
                  return 'Database name cannot contain spaces'
                if (input === oldName) return 'New name must be different'
                return true
              },
            },
          ])
          newName = dbName
        }

        // Validate old != new
        if (oldName === newName) {
          outputError(
            `Old and new database names are the same: "${oldName}"`,
            options.json,
          )
        }

        // Validate old name exists
        if (!trackedDatabases.includes(oldName)) {
          outputError(
            `Database "${oldName}" is not tracked in "${containerName}". Use "spindb databases remove ${containerName} ${oldName}" to clean up stale entries.`,
            options.json,
          )
        }

        // Validate new name doesn't already exist
        if (trackedDatabases.includes(newName)) {
          outputError(
            `Database "${newName}" already exists in "${containerName}"`,
            options.json,
          )
        }

        // Check server for new name too
        const engine = getEngine(config.engine)
        try {
          const serverDatabases = await engine.listDatabases(config)
          if (!serverDatabases.includes(oldName)) {
            outputError(
              `Database "${oldName}" does not exist on the server. Use "spindb databases remove ${containerName} ${oldName}" to clean up tracking.`,
              options.json,
            )
          }
          if (serverDatabases.includes(newName)) {
            outputError(
              `Database "${newName}" already exists on the server`,
              options.json,
            )
          }
        } catch {
          // listDatabases may not be supported; proceed anyway
        }

        const caps = getDatabaseCapabilities(config.engine)
        const useNativeRename =
          caps.supportsRename === 'native' && !options.backup
        const isPrimaryRename = oldName === config.database

        if (isPrimaryRename && !options.json) {
          console.log(
            uiWarning(
              `Renaming the primary database. The primary will be updated to "${newName}".`,
            ),
          )
        }

        if (useNativeRename) {
          // Native rename path (PostgreSQL, ClickHouse, CockroachDB, Meilisearch)
          if (!options.json) {
            const spinner = createSpinner(
              `Renaming "${oldName}" to "${newName}" in "${containerName}"...`,
            )
            spinner.start()
            try {
              await engine.renameDatabase(config, oldName, newName)
              spinner.succeed(`Renamed "${oldName}" to "${newName}"`)
            } catch (error) {
              spinner.fail(`Failed to rename database`)
              throw error
            }
          } else {
            await engine.renameDatabase(config, oldName, newName)
          }

          // Update tracking
          await updateRenameTracking(containerName, oldName, newName, {
            shouldDrop: true,
            isPrimaryRename,
          })

          const connectionString = engine.getConnectionString(
            { ...config, database: newName },
            newName,
          )

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  container: containerName,
                  engine: config.engine,
                  oldName,
                  newName,
                  method: 'native',
                  connectionString,
                  primaryChanged: isPrimaryRename,
                },
                null,
                2,
              ),
            )
          } else {
            console.log(
              chalk.gray(`  Connection: ${chalk.white(connectionString)}`),
            )
            if (isPrimaryRename) {
              console.log(
                chalk.gray(
                  `  Note: The primary database has been changed to "${newName}".`,
                ),
              )
            }
          }
        } else {
          // Backup/restore rename path
          if (!options.json) {
            console.log(
              `\n${engine.displayName} does not support native database renaming.`,
            )
            console.log(
              `Cloning "${oldName}" to "${newName}" in "${containerName}" via backup/restore...\n`,
            )
          }

          await mkdir(paths.renameBackups, { recursive: true })

          const format = getDefaultFormat(config.engine)
          const extension = getBackupExtension(config.engine, format)
          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '')
            .slice(0, 15)
          const backupFileName = `${containerName}-${oldName}-rename-${timestamp}${extension}`
          const backupPath = join(paths.renameBackups, backupFileName)

          let backupSize = 0

          // Step 1: Backup old database
          if (!options.json) {
            const spinner = createSpinner(`Backing up "${oldName}"...`)
            spinner.start()
            try {
              const result = await engine.backup(config, backupPath, {
                database: oldName,
                format,
              })
              backupSize = result.size
              const sizeStr =
                backupSize > 0 ? ` (${formatBackupSize(backupSize)})` : ''
              spinner.succeed(`Backed up "${oldName}"${sizeStr}`)
            } catch (error) {
              spinner.fail(`Failed to backup "${oldName}"`)
              throw error
            }
          } else {
            const result = await engine.backup(config, backupPath, {
              database: oldName,
              format,
            })
            backupSize = result.size
          }

          // Step 2: Create new database
          let newDbCreated = false
          try {
            if (!options.json) {
              const spinner = createSpinner(`Creating database "${newName}"...`)
              spinner.start()
              try {
                await engine.createDatabase(config, newName)
                newDbCreated = true
                spinner.succeed(`Created database "${newName}"`)
              } catch (error) {
                spinner.fail(`Failed to create database "${newName}"`)
                throw error
              }
            } else {
              await engine.createDatabase(config, newName)
              newDbCreated = true
            }
          } catch (error) {
            // Rollback: delete backup file
            try {
              await unlink(backupPath)
            } catch {
              // Backup file may not exist
            }
            throw error
          }

          // Step 3: Restore data to new database
          try {
            if (!options.json) {
              const spinner = createSpinner(`Restoring data to "${newName}"...`)
              spinner.start()
              try {
                await engine.restore(
                  { ...config, database: newName },
                  backupPath,
                  { database: newName },
                )
                spinner.succeed(`Restored data to "${newName}"`)
              } catch (error) {
                spinner.fail(`Failed to restore data to "${newName}"`)
                throw error
              }
            } else {
              await engine.restore(
                { ...config, database: newName },
                backupPath,
                { database: newName },
              )
            }
          } catch (error) {
            // Rollback: drop newly created database, keep backup
            if (newDbCreated) {
              try {
                await engine.dropDatabase(config, newName)
              } catch {
                // Best-effort cleanup
              }
            }
            const e = error as Error
            const msg = `Restore failed: ${e.message}\nSafety backup retained at: ${backupPath}`
            outputError(msg, options.json)
          }

          // Step 4: Verify new database exists
          if (!options.json) {
            const spinner = createSpinner(`Verifying "${newName}" exists...`)
            spinner.start()
            try {
              const serverDbs = await engine.listDatabases(config)
              if (serverDbs.includes(newName)) {
                spinner.succeed(`Verified "${newName}" exists`)
              } else {
                spinner.warn(`Could not verify "${newName}" via listDatabases`)
              }
            } catch {
              spinner.warn(`Verification skipped (listDatabases not supported)`)
            }
          }

          // Step 5: Drop old database (unless --no-drop)
          // options.drop is false when --no-drop is passed (commander inverts it)
          const shouldDrop = options.drop !== false
          let dropSucceeded = false
          if (shouldDrop) {
            if (!options.json) {
              const spinner = createSpinner(
                `Dropping old database "${oldName}"...`,
              )
              spinner.start()
              try {
                await engine.terminateConnections(config, oldName)
                await engine.dropDatabase(config, oldName)
                spinner.succeed(`Dropped old database "${oldName}"`)
                dropSucceeded = true
              } catch (error) {
                const e = error as Error
                spinner.warn(
                  `Could not drop old database "${oldName}": ${e.message}`,
                )
                // Non-fatal — data is safely in new database
              }
            } else {
              try {
                await engine.terminateConnections(config, oldName)
                await engine.dropDatabase(config, oldName)
                dropSucceeded = true
              } catch {
                // Non-fatal warning in JSON mode
              }
            }
          }

          // Update tracking — only remove old DB from tracking if drop actually succeeded
          await updateRenameTracking(containerName, oldName, newName, {
            shouldDrop: dropSucceeded,
            isPrimaryRename,
          })

          const connectionString = engine.getConnectionString(
            { ...config, database: newName },
            newName,
          )

          // Get backup file size
          try {
            const backupStat = await stat(backupPath)
            backupSize = backupStat.size
          } catch {
            // Use previously captured size
          }

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  container: containerName,
                  engine: config.engine,
                  oldName,
                  newName,
                  method: 'backup-restore',
                  backup: {
                    path: backupPath,
                    size: backupSize,
                    format: String(format),
                  },
                  connectionString,
                  primaryChanged: isPrimaryRename,
                },
                null,
                2,
              ),
            )
          } else {
            console.log(`\nRename complete.`)
            console.log(
              chalk.gray(`  Safety backup: ${chalk.white(backupPath)}`),
            )
            console.log(
              chalk.gray(`  Connection:    ${chalk.white(connectionString)}`),
            )
            if (isPrimaryRename) {
              console.log(
                chalk.gray(
                  `\n  Note: The primary database has been changed to "${newName}".`,
                ),
              )
            }
          }
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
