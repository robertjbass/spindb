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
export const databasesCommand = new Command('databases')
  .description('Manage database tracking within a container')

// List databases in a container
databasesCommand
  .command('list')
  .description('List tracked databases in a container')
  .argument('<container>', 'Container name')
  .option('-j, --json', 'Output as JSON')
  .action(async (container: string, options: { json?: boolean }) => {
    try {
      const config = await containerManager.getConfig(container)
      if (!config) {
        if (options.json) {
          console.log(JSON.stringify({ error: `Container "${container}" not found` }))
        } else {
          console.error(uiError(`Container "${container}" not found`))
        }
        process.exit(1)
      }

      const databases = config.databases || [config.database]

      if (options.json) {
        console.log(JSON.stringify({
          container,
          primary: config.database,
          databases,
        }))
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
        console.log(JSON.stringify({ error: e.message }))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })

// Add a database to tracking
databasesCommand
  .command('add')
  .description('Add a database to tracking (does not create the actual database)')
  .argument('<container>', 'Container name')
  .argument('<database>', 'Database name to add')
  .option('-j, --json', 'Output as JSON')
  .action(async (container: string, database: string, options: { json?: boolean }) => {
    try {
      const config = await containerManager.getConfig(container)
      if (!config) {
        if (options.json) {
          console.log(JSON.stringify({ error: `Container "${container}" not found` }))
        } else {
          console.error(uiError(`Container "${container}" not found`))
        }
        process.exit(1)
      }

      const databases = config.databases || [config.database]
      if (databases.includes(database)) {
        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            message: `Database "${database}" is already tracked`,
            databases,
          }))
        } else {
          console.log(chalk.gray(`Database "${database}" is already tracked in "${container}"`))
        }
        return
      }

      await containerManager.addDatabase(container, database)
      const updatedConfig = await containerManager.getConfig(container)
      const updatedDatabases = updatedConfig?.databases || []

      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          added: database,
          databases: updatedDatabases,
        }))
      } else {
        console.log(uiSuccess(`Added "${database}" to tracking in "${container}"`))
      }
    } catch (error) {
      const e = error as Error
      if (options.json) {
        console.log(JSON.stringify({ error: e.message }))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })

// Remove a database from tracking
databasesCommand
  .command('remove')
  .description('Remove a database from tracking (does not drop the actual database)')
  .argument('<container>', 'Container name')
  .argument('<database>', 'Database name to remove')
  .option('-j, --json', 'Output as JSON')
  .action(async (container: string, database: string, options: { json?: boolean }) => {
    try {
      const config = await containerManager.getConfig(container)
      if (!config) {
        if (options.json) {
          console.log(JSON.stringify({ error: `Container "${container}" not found` }))
        } else {
          console.error(uiError(`Container "${container}" not found`))
        }
        process.exit(1)
      }

      // Check if trying to remove primary database
      if (database === config.database) {
        const errorMsg = `Cannot remove primary database "${database}" from tracking`
        if (options.json) {
          console.log(JSON.stringify({ error: errorMsg }))
        } else {
          console.error(uiError(errorMsg))
        }
        process.exit(1)
      }

      const databases = config.databases || [config.database]
      if (!databases.includes(database)) {
        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            message: `Database "${database}" is not tracked`,
            databases,
          }))
        } else {
          console.log(chalk.gray(`Database "${database}" is not tracked in "${container}"`))
        }
        return
      }

      await containerManager.removeDatabase(container, database)
      const updatedConfig = await containerManager.getConfig(container)
      const updatedDatabases = updatedConfig?.databases || []

      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          removed: database,
          databases: updatedDatabases,
        }))
      } else {
        console.log(uiSuccess(`Removed "${database}" from tracking in "${container}"`))
      }
    } catch (error) {
      const e = error as Error
      if (options.json) {
        console.log(JSON.stringify({ error: e.message }))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })

// Sync command - update tracking after rename operations
databasesCommand
  .command('sync')
  .description('Sync tracking after database rename (removes old, adds new)')
  .argument('<container>', 'Container name')
  .argument('<old-name>', 'Old database name to remove from tracking')
  .argument('<new-name>', 'New database name to add to tracking')
  .option('-j, --json', 'Output as JSON')
  .action(async (container: string, oldName: string, newName: string, options: { json?: boolean }) => {
    try {
      const config = await containerManager.getConfig(container)
      if (!config) {
        if (options.json) {
          console.log(JSON.stringify({ error: `Container "${container}" not found` }))
        } else {
          console.error(uiError(`Container "${container}" not found`))
        }
        process.exit(1)
      }

      // Cannot sync if old name is the primary database
      if (oldName === config.database) {
        const errorMsg = `Cannot sync primary database "${oldName}". Use 'spindb edit' to change the primary database.`
        if (options.json) {
          console.log(JSON.stringify({ error: errorMsg }))
        } else {
          console.error(uiError(errorMsg))
        }
        process.exit(1)
      }

      // Add new name first (in case old name doesn't exist in tracking)
      await containerManager.addDatabase(container, newName)

      // Remove old name if it was tracked
      const databases = config.databases || [config.database]
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
        console.log(JSON.stringify(result))
      } else {
        console.log(uiSuccess(`Synced database rename: "${oldName}" -> "${newName}" in "${container}"`))
      }
    } catch (error) {
      const e = error as Error
      if (options.json) {
        console.log(JSON.stringify({ error: e.message }))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })
