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
import { uiSuccess, uiError, uiWarning, formatBytes } from '../ui/theme'
import { getMissingDependencies } from '../../core/dependency-manager'
import { isFileBasedEngine, isRemoteContainer } from '../../types'
import {
  getBackupExtension,
  getBackupSpinnerLabel,
  getDefaultFormat,
  isValidFormat,
  getValidFormats,
} from '../../config/backup-formats'
import type { BackupFormatType, ContainerConfig } from '../../types'
import {
  type DatabaseLister,
  probeDatabasePresence,
} from '../../core/database-presence'

function generateTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/:/g, '').split('.')[0]
}

type DatabaseNotFoundResult = {
  error: string
  code: 'database_not_found'
  database: string
  availableDatabases: string[]
}

/**
 * The structured refusal for a backup whose target database the server
 * proved absent, or null when the backup should proceed. Only engines where a
 * database exists even when empty can prove absence; a failed or inconclusive
 * listing ('unknown') proceeds exactly as before. Exported for tests.
 */
export async function checkBackupTarget(options: {
  engine: DatabaseLister
  container: ContainerConfig
  database: string
}): Promise<DatabaseNotFoundResult | null> {
  const { engine, container, database } = options
  const probe = await probeDatabasePresence({
    engine,
    container,
    name: database,
  })
  if (probe.presence !== false) return null

  const availableDatabases = probe.listed ?? []
  const available =
    availableDatabases.length > 0
      ? `Available databases: ${availableDatabases.join(', ')}. Back up one of those with -d <name>.`
      : 'The server has no user databases.'
  return {
    error: `Database "${database}" does not exist in container "${container.name}". ${available} To refresh the tracked list, run: spindb databases refresh ${container.name}`,
    code: 'database_not_found',
    database,
    availableDatabases,
  }
}

function generateDefaultFilename(
  containerName: string,
  database: string,
): string {
  const timestamp = generateTimestamp()
  return `${containerName}-${database}-backup-${timestamp}`
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
  .option(
    '--format <format>',
    'Backup format (engine-specific, e.g., sql, custom, rdb, binary)',
  )
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (
      containerArg: string | undefined,
      options: {
        database?: string
        name?: string
        output?: string
        format?: string
        json?: boolean
      },
    ) => {
      // Engine for the missing-tool hint; unknown until the config loads
      let engineForHint: string | undefined
      try {
        let containerName = containerArg

        if (!containerName) {
          // JSON mode requires container name argument
          if (options.json) {
            console.log(JSON.stringify({ error: 'Container name is required' }))
            process.exit(1)
          }

          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            if (containers.length === 0) {
              console.log(
                uiWarning(
                  'No containers found. Create one with: spindb create',
                ),
              )
            } else {
              console.log(
                uiWarning(
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

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error: `Container "${containerName}" not found`,
              }),
            )
          } else {
            console.error(uiError(`Container "${containerName}" not found`))
          }
          process.exit(1)
        }

        const { engine: engineName } = config
        engineForHint = engineName

        // Remote containers: backup not yet supported (engine methods connect to 127.0.0.1)
        if (isRemoteContainer(config)) {
          const errorMsg =
            "Backup is not yet supported for linked remote containers. Use your database provider's backup tools instead."
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // File-based engines don't need running check
        if (!isFileBasedEngine(engineName)) {
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            const errorMsg = `Container "${containerName}" is not running. Start it first.`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        const engine = getEngine(engineName)

        const depsSpinner = createSpinner('Checking required tools...')
        depsSpinner.start()

        let missingDeps = await getMissingDependencies(config.engine)
        if (missingDeps.length > 0) {
          depsSpinner.warn(
            `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
          )

          const installed = await promptInstallDependencies(
            missingDeps[0].binary,
            config.engine,
          )

          if (!installed) {
            process.exit(1)
          }

          missingDeps = await getMissingDependencies(config.engine)
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
          depsSpinner.succeed('Required tools available')
        }

        let databaseName = options.database

        if (!databaseName) {
          const databases = config.databases || [config.database]

          if (databases.length > 1) {
            databaseName = await promptDatabaseSelect(
              databases,
              'Select database to backup:',
            )
          } else {
            databaseName = databases[0]
          }
        }

        // Engines where a database exists even when empty can prove the target
        // is gone. Report that directly instead of the dump tool's raw error.
        // 'unknown' proceeds exactly as before.
        const notFound = await checkBackupTarget({
          engine,
          container: config,
          database: databaseName,
        })
        if (notFound) {
          if (options.json) {
            console.log(JSON.stringify(notFound))
          } else {
            console.error(uiError(notFound.error))
          }
          process.exit(1)
        }

        let format: BackupFormatType = getDefaultFormat(engineName)

        if (options.format) {
          if (!isValidFormat(engineName, options.format)) {
            const validFormats = getValidFormats(engineName)
            const errorMsg = `Invalid format "${options.format}" for ${engineName}. Valid formats: ${validFormats.join(', ')}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
          // Safe to cast: isValidFormat above guarantees the format is valid
          format = options.format as BackupFormatType
        } else if (!containerArg) {
          const selectedFormat = await promptBackupFormat(engineName)
          if (selectedFormat) {
            format = selectedFormat
          }
        }

        const defaultFilename = generateDefaultFilename(
          containerName,
          databaseName,
        )
        let filename = options.name || defaultFilename

        if (!containerArg && !options.name) {
          filename = await promptBackupFilename(defaultFilename)
        }

        const extension = getBackupExtension(engineName, format)
        const outputDir = options.output || process.cwd()
        const outputPath = join(outputDir, `${filename}${extension}`)

        const spinnerLabel = getBackupSpinnerLabel(engineName, format)
        const backupSpinner = createSpinner(
          `Creating ${spinnerLabel} backup of "${databaseName}"...`,
        )
        backupSpinner.start()

        const result = await engine.backup(config, outputPath, {
          database: databaseName,
          format,
        })

        backupSpinner.succeed('Backup created successfully')

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              path: result.path,
              size: result.size,
              format: result.format,
              database: databaseName,
              container: containerName,
            }),
          )
        } else {
          console.log()
          console.log(uiSuccess('Backup complete'))
          console.log()
          console.log(chalk.gray('  Saved to:'), chalk.cyan(result.path))
          console.log(
            chalk.gray('  Size:'),
            chalk.white(formatBytes(result.size)),
          )
          console.log(chalk.gray('  Format:'), chalk.white(result.format))
          console.log()
        }
      } catch (error) {
        const e = error as Error

        // Most specific first: MariaDB's message names both tools
        const missingToolPatterns = [
          'pg_dump not found',
          'mariadb-dump or mysqldump not found',
          'mariadb-dump not found',
          'mysqldump not found',
        ]

        const matchingPattern = missingToolPatterns.find((p) =>
          e.message.includes(p),
        )

        if (matchingPattern) {
          if (options.json) {
            console.log(JSON.stringify({ error: e.message }))
            process.exit(1)
          }
          const missingTool = matchingPattern
            .replace(' or mysqldump', '')
            .replace(' not found', '')
          const installed = await promptInstallDependencies(
            missingTool,
            engineForHint,
          )
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
      }
    },
  )
