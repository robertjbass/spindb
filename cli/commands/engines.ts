import { Command } from 'commander'
import chalk from 'chalk'
import { rm } from 'fs/promises'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { error, warning, info, formatBytes } from '../ui/theme'
import { getEngineIcon, ENGINE_ICONS } from '../constants'
import {
  getInstalledEngines,
  getInstalledPostgresEngines,
  type InstalledPostgresEngine,
  type InstalledMysqlEngine,
  type InstalledSqliteEngine,
} from '../helpers'

/**
 * Pad string to width, accounting for emoji taking 2 display columns
 */
function padWithEmoji(str: string, width: number): string {
  // Count emojis (they take 2 display columns but count as 1-2 chars)
  const emojiCount = (str.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length
  return str.padEnd(width + emojiCount)
}

/**
 * List subcommand action
 */
async function listEngines(options: { json?: boolean }): Promise<void> {
  const engines = await getInstalledEngines()

  if (options.json) {
    console.log(JSON.stringify(engines, null, 2))
    return
  }

  if (engines.length === 0) {
    console.log(info('No engines installed yet.'))
    console.log(
      chalk.gray(
        '  PostgreSQL engines are downloaded automatically when you create a container.',
      ),
    )
    console.log(
      chalk.gray(
        '  MySQL requires system installation (brew install mysql or apt install mysql-server).',
      ),
    )
    return
  }

  // Separate engines by type
  const pgEngines = engines.filter(
    (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
  )
  const mysqlEngine = engines.find(
    (e): e is InstalledMysqlEngine => e.engine === 'mysql',
  )
  const sqliteEngine = engines.find(
    (e): e is InstalledSqliteEngine => e.engine === 'sqlite',
  )

  // Calculate total size for PostgreSQL
  const totalPgSize = pgEngines.reduce((acc, e) => acc + e.sizeBytes, 0)

  // Table header
  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.bold.white('ENGINE'.padEnd(14)) +
      chalk.bold.white('VERSION'.padEnd(12)) +
      chalk.bold.white('SOURCE'.padEnd(18)) +
      chalk.bold.white('SIZE'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(55)))

  // PostgreSQL rows
  for (const engine of pgEngines) {
    const icon = getEngineIcon(engine.engine)
    const platformInfo = `${engine.platform}-${engine.arch}`
    const engineDisplay = `${icon} ${engine.engine}`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(engine.version.padEnd(12)) +
        chalk.gray(platformInfo.padEnd(18)) +
        chalk.white(formatBytes(engine.sizeBytes)),
    )
  }

  // MySQL row
  if (mysqlEngine) {
    const icon = ENGINE_ICONS.mysql
    const displayName = mysqlEngine.isMariaDB ? 'mariadb' : 'mysql'
    const engineDisplay = `${icon} ${displayName}`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(mysqlEngine.version.padEnd(12)) +
        chalk.gray('system'.padEnd(18)) +
        chalk.gray('(system-installed)'),
    )
  }

  // SQLite row
  if (sqliteEngine) {
    const icon = ENGINE_ICONS.sqlite
    const engineDisplay = `${icon} sqlite`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(sqliteEngine.version.padEnd(12)) +
        chalk.gray('system'.padEnd(18)) +
        chalk.gray('(system-installed)'),
    )
  }

  console.log(chalk.gray('  ' + '─'.repeat(55)))

  // Summary
  console.log()
  if (pgEngines.length > 0) {
    console.log(
      chalk.gray(
        `  PostgreSQL: ${pgEngines.length} version(s), ${formatBytes(totalPgSize)}`,
      ),
    )
  }
  if (mysqlEngine) {
    console.log(chalk.gray(`  MySQL: system-installed at ${mysqlEngine.path}`))
  }
  if (sqliteEngine) {
    console.log(chalk.gray(`  SQLite: system-installed at ${sqliteEngine.path}`))
  }
  console.log()
}

/**
 * Delete subcommand action
 */
async function deleteEngine(
  engine: string | undefined,
  version: string | undefined,
  options: { yes?: boolean },
): Promise<void> {
  // Get PostgreSQL engines only (MySQL can't be deleted via spindb)
  const pgEngines = await getInstalledPostgresEngines()

  if (pgEngines.length === 0) {
    console.log(warning('No deletable engines found.'))
    console.log(
      chalk.gray(
        '  MySQL is system-installed and cannot be deleted via spindb.',
      ),
    )
    return
  }

  let engineName = engine
  let engineVersion = version

  // Interactive selection if not provided
  if (!engineName || !engineVersion) {
    const choices = pgEngines.map((e) => ({
      name: `${getEngineIcon(e.engine)} ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `${e.engine}:${e.version}:${e.path}`,
    }))

    const { selected } = await inquirer.prompt<{ selected: string }>([
      {
        type: 'list',
        name: 'selected',
        message: 'Select engine to delete:',
        choices,
      },
    ])

    const [eng, ver] = selected.split(':')
    engineName = eng
    engineVersion = ver
  }

  // Find the engine
  const targetEngine = pgEngines.find(
    (e) => e.engine === engineName && e.version === engineVersion,
  )

  if (!targetEngine) {
    console.error(error(`Engine "${engineName} ${engineVersion}" not found`))
    process.exit(1)
  }

  // Check if any containers are using this engine version
  const containers = await containerManager.list()
  const usingContainers = containers.filter(
    (c) => c.engine === engineName && c.version === engineVersion,
  )

  if (usingContainers.length > 0) {
    console.error(
      error(
        `Cannot delete: ${usingContainers.length} container(s) are using ${engineName} ${engineVersion}`,
      ),
    )
    console.log(
      chalk.gray(
        `  Containers: ${usingContainers.map((c) => c.name).join(', ')}`,
      ),
    )
    console.log()
    console.log(chalk.gray('  Delete these containers first, then try again.'))
    process.exit(1)
  }

  // Confirm deletion
  if (!options.yes) {
    const confirmed = await promptConfirm(
      `Delete ${engineName} ${engineVersion}? This cannot be undone.`,
      false,
    )

    if (!confirmed) {
      console.log(warning('Deletion cancelled'))
      return
    }
  }

  // Delete the engine
  const spinner = createSpinner(`Deleting ${engineName} ${engineVersion}...`)
  spinner.start()

  try {
    await rm(targetEngine.path, { recursive: true, force: true })
    spinner.succeed(`Deleted ${engineName} ${engineVersion}`)
  } catch (err) {
    const e = err as Error
    spinner.fail(`Failed to delete: ${e.message}`)
    process.exit(1)
  }
}

// Main engines command
export const enginesCommand = new Command('engines')
  .description('Manage installed database engines')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      await listEngines(options)
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })

// Delete subcommand
enginesCommand
  .command('delete [engine] [version]')
  .description('Delete an installed engine version')
  .option('-y, --yes', 'Skip confirmation')
  .action(
    async (
      engine: string | undefined,
      version: string | undefined,
      options: { yes?: boolean },
    ) => {
      try {
        await deleteEngine(engine, version, options)
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
