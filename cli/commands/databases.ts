import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { uiError, uiSuccess } from '../ui/theme'

/**
 * CLI command for managing database tracking within containers.
 *
 * SpinDB tracks which databases exist within a container for informational purposes.
 * This command allows adding/removing databases from tracking without actually
 * creating/dropping them in the database server.
 *
 * Use cases:
 * - After renaming databases via SQL, update SpinDB's tracking to match
 * - After external scripts create/drop databases, sync the tracking
 * - Clean up stale database entries from tracking
 */
export const databasesCommand = new Command('databases').description(
  'Manage database tracking within a container',
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
            const result = containers.map((c) => {
              const rawDatabases = c.databases || []
              const databases = [...new Set([c.database, ...rawDatabases])]
              return {
                container: c.name,
                engine: c.engine,
                primary: c.database,
                databases,
              }
            })
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
          // Return the full container config - it's already JSON and has all the info
          console.log(JSON.stringify(config, null, 2))
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
