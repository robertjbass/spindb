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

function generateTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/:/g, '').split('.')[0]
}

function generateDefaultFilename(
  containerName: string,
  database: string,
): string {
  const timestamp = generateTimestamp()
  return `${containerName}-${database}-backup-${timestamp}`
}

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

        if (!containerName) {
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
          console.error(uiError(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const { engine: engineName } = config

        const running = await processManager.isRunning(containerName, {
          engine: engineName,
        })
        if (!running) {
          console.error(
            uiError(
              `Container "${containerName}" is not running. Start it first.`,
            ),
          )
          process.exit(1)
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

        let format: 'sql' | 'dump' = 'sql'

        if (options.sql) {
          format = 'sql'
        } else if (options.dump) {
          format = 'dump'
        } else if (options.format) {
          if (options.format !== 'sql' && options.format !== 'dump') {
            console.error(uiError('Format must be "sql" or "dump"'))
            process.exit(1)
          }
          format = options.format as 'sql' | 'dump'
        } else if (!containerArg) {
          format = await promptBackupFormat(engineName)
        }

        const defaultFilename = generateDefaultFilename(
          containerName,
          databaseName,
        )
        let filename = options.name || defaultFilename

        if (!containerArg && !options.name) {
          filename = await promptBackupFilename(defaultFilename)
        }

        const extension = getExtension(format, engineName)
        const outputDir = options.output || process.cwd()
        const outputPath = join(outputDir, `${filename}${extension}`)

        const backupSpinner = createSpinner(
          `Creating ${format === 'sql' ? 'SQL' : 'dump'} backup of "${databaseName}"...`,
        )
        backupSpinner.start()

        const result = await engine.backup(config, outputPath, {
          database: databaseName,
          format,
        })

        backupSpinner.succeed('Backup created successfully')

        console.log()
        console.log(uiSuccess('Backup complete'))
        console.log()
        console.log(chalk.gray('  File:'), chalk.cyan(result.path))
        console.log(
          chalk.gray('  Size:'),
          chalk.white(formatBytes(result.size)),
        )
        console.log(chalk.gray('  Format:'), chalk.white(result.format))
        console.log()
      } catch (error) {
        const e = error as Error

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

        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
