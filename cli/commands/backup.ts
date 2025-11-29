import { Command } from 'commander'
import { join } from 'path'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import {
  promptContainerSelect,
  promptDatabaseSelect,
  promptBackupFormat,
  promptBackupFilename,
  promptInstallDependencies,
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { success, error, warning, formatBytes } from '../ui/theme'
import { getMissingDependencies } from '../../core/dependency-manager'

/**
 * Generate a timestamp string for backup filenames
 * Format: YYYY-MM-DDTHHMMSS (ISO 8601 without colons for filesystem compatibility)
 */
function generateTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/:/g, '').split('.')[0]
}

/**
 * Generate default backup filename
 */
function generateDefaultFilename(
  containerName: string,
  database: string,
): string {
  const timestamp = generateTimestamp()
  return `${containerName}-${database}-backup-${timestamp}`
}

/**
 * Get file extension for backup format
 */
function getExtension(format: 'sql' | 'dump', engine: string): string {
  if (format === 'sql') {
    return '.sql'
  }
  // MySQL dump is gzipped SQL, PostgreSQL dump is custom format
  return engine === 'mysql' ? '.sql.gz' : '.dump'
}

export const backupCommand = new Command('backup')
  .description('Create a backup of a database')
  .argument('[container]', 'Container name')
  .option('-d, --database <name>', 'Database to backup')
  .option('-n, --name <name>', 'Custom backup filename (without extension)')
  .option(
    '-o, --output <path>',
    'Output directory (defaults to current directory)',
  )
  .option('--format <format>', 'Output format: sql or dump')
  .option('--sql', 'Output as plain SQL (shorthand for --format sql)')
  .option('--dump', 'Output as dump format (shorthand for --format dump)')
  .action(
    async (
      containerArg: string | undefined,
      options: {
        database?: string
        name?: string
        output?: string
        format?: string
        sql?: boolean
        dump?: boolean
      },
    ) => {
      try {
        let containerName = containerArg

        // Interactive selection if no container provided
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
            'Select container to backup:',
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

        // Check if running
        const running = await processManager.isRunning(containerName, {
          engine: engineName,
        })
        if (!running) {
          console.error(
            error(
              `Container "${containerName}" is not running. Start it first.`,
            ),
          )
          process.exit(1)
        }

        // Get engine
        const engine = getEngine(engineName)

        // Check for required client tools
        const depsSpinner = createSpinner('Checking required tools...')
        depsSpinner.start()

        let missingDeps = await getMissingDependencies(config.engine)
        if (missingDeps.length > 0) {
          depsSpinner.warn(
            `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
          )

          // Offer to install
          const installed = await promptInstallDependencies(
            missingDeps[0].binary,
            config.engine,
          )

          if (!installed) {
            process.exit(1)
          }

          // Verify installation worked
          missingDeps = await getMissingDependencies(config.engine)
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

        // Determine which database to backup
        let databaseName = options.database

        if (!databaseName) {
          // Get list of databases in container
          const databases = config.databases || [config.database]

          if (databases.length > 1) {
            // Interactive mode: prompt for database selection
            databaseName = await promptDatabaseSelect(
              databases,
              'Select database to backup:',
            )
          } else {
            // Single database: use it
            databaseName = databases[0]
          }
        }

        // Determine format
        let format: 'sql' | 'dump' = 'sql' // Default to SQL

        if (options.sql) {
          format = 'sql'
        } else if (options.dump) {
          format = 'dump'
        } else if (options.format) {
          if (options.format !== 'sql' && options.format !== 'dump') {
            console.error(error('Format must be "sql" or "dump"'))
            process.exit(1)
          }
          format = options.format as 'sql' | 'dump'
        } else if (!containerArg) {
          // Interactive mode: prompt for format
          format = await promptBackupFormat(engineName)
        }

        // Determine filename
        const defaultFilename = generateDefaultFilename(
          containerName,
          databaseName,
        )
        let filename = options.name || defaultFilename

        // In interactive mode with no name provided, optionally prompt for custom name
        if (!containerArg && !options.name) {
          filename = await promptBackupFilename(defaultFilename)
        }

        // Build full output path
        const extension = getExtension(format, engineName)
        const outputDir = options.output || process.cwd()
        const outputPath = join(outputDir, `${filename}${extension}`)

        // Create backup
        const backupSpinner = createSpinner(
          `Creating ${format === 'sql' ? 'SQL' : 'dump'} backup of "${databaseName}"...`,
        )
        backupSpinner.start()

        const result = await engine.backup(config, outputPath, {
          database: databaseName,
          format,
        })

        backupSpinner.succeed('Backup created successfully')

        // Show result
        console.log()
        console.log(success('Backup complete'))
        console.log()
        console.log(chalk.gray('  File:'), chalk.cyan(result.path))
        console.log(
          chalk.gray('  Size:'),
          chalk.white(formatBytes(result.size)),
        )
        console.log(chalk.gray('  Format:'), chalk.white(result.format))
        console.log()
      } catch (err) {
        const e = err as Error

        // Check if this is a missing tool error
        const missingToolPatterns = ['pg_dump not found', 'mysqldump not found']

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
      }
    },
  )
