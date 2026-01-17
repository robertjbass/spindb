import chalk from 'chalk'
import inquirer from 'inquirer'
import { rm } from 'fs/promises'
import stringWidth from 'string-width'
import { containerManager } from '../../../core/container-manager'
import { createSpinner } from '../../ui/spinner'
import { header, uiError, uiWarning, uiInfo, formatBytes } from '../../ui/theme'
import { promptConfirm } from '../../ui/prompts'
import { getEngineIcon } from '../../constants'
import {
  getInstalledEngines,
  type InstalledPostgresEngine,
  type InstalledMariadbEngine,
  type InstalledMysqlEngine,
  type InstalledSqliteEngine,
  type InstalledMongodbEngine,
  type InstalledRedisEngine,
  type InstalledValkeyEngine,
  type InstalledClickHouseEngine,
} from '../../helpers'

import { type MenuChoice } from './shared'

// Pad string to target visual width, accounting for Unicode character widths
function padToWidth(str: string, targetWidth: number): string {
  const currentWidth = stringWidth(str)
  const padding = Math.max(0, targetWidth - currentWidth)
  return str + ' '.repeat(padding)
}

export async function handleEngines(): Promise<void> {
  console.clear()
  console.log(header('Installed Engines'))
  console.log()

  const engines = await getInstalledEngines()

  if (engines.length === 0) {
    console.log(uiInfo('No engines installed yet.'))
    console.log(
      chalk.gray(
        '  Database engines are downloaded automatically when you create a container.',
      ),
    )
    console.log(
      chalk.gray('  Or use: spindb engines download <engine> <version>'),
    )
    return
  }

  const [
    pgEngines,
    mariadbEngines,
    mysqlEngines,
    sqliteEngines,
    mongodbEngines,
    redisEngines,
    valkeyEngines,
    clickhouseEngines,
  ] = [
    engines.filter(
      (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
    ),
    engines.filter((e): e is InstalledMariadbEngine => e.engine === 'mariadb'),
    engines.filter((e): e is InstalledMysqlEngine => e.engine === 'mysql'),
    engines.filter((e): e is InstalledSqliteEngine => e.engine === 'sqlite'),
    engines.filter((e): e is InstalledMongodbEngine => e.engine === 'mongodb'),
    engines.filter((e): e is InstalledRedisEngine => e.engine === 'redis'),
    engines.filter((e): e is InstalledValkeyEngine => e.engine === 'valkey'),
    engines.filter(
      (e): e is InstalledClickHouseEngine => e.engine === 'clickhouse',
    ),
  ]

  const totalPgSize = pgEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
  const totalMariadbSize = mariadbEngines.reduce(
    (acc, e) => acc + e.sizeBytes,
    0,
  )
  const totalMysqlSize = mysqlEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
  const totalSqliteSize = sqliteEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
  const totalMongodbSize = mongodbEngines.reduce(
    (acc, e) => acc + e.sizeBytes,
    0,
  )
  const totalRedisSize = redisEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
  const totalValkeySize = valkeyEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
  const totalClickhouseSize = clickhouseEngines.reduce(
    (acc, e) => acc + e.sizeBytes,
    0,
  )

  const COL_ENGINE = 14
  const COL_VERSION = 12
  const COL_SOURCE = 18

  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.bold.white('ENGINE'.padEnd(COL_ENGINE)) +
      chalk.bold.white('VERSION'.padEnd(COL_VERSION)) +
      chalk.bold.white('SOURCE'.padEnd(COL_SOURCE)) +
      chalk.bold.white('SIZE'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(55)))

  // Render all engines grouped by type
  const allEnginesSorted = [
    ...pgEngines,
    ...mariadbEngines,
    ...mysqlEngines,
    ...sqliteEngines,
    ...mongodbEngines,
    ...redisEngines,
    ...valkeyEngines,
    ...clickhouseEngines,
  ]

  for (const engine of allEnginesSorted) {
    const icon = getEngineIcon(engine.engine)
    const platformInfo = `${engine.platform}-${engine.arch}`
    const engineDisplay = `${icon} ${engine.engine}`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padToWidth(engineDisplay, COL_ENGINE)) +
        chalk.yellow(engine.version.padEnd(COL_VERSION)) +
        chalk.gray(platformInfo.padEnd(COL_SOURCE)) +
        chalk.white(formatBytes(engine.sizeBytes)),
    )
  }

  console.log(chalk.gray('  ' + '─'.repeat(55)))

  console.log()
  if (pgEngines.length > 0) {
    console.log(
      chalk.gray(
        `  PostgreSQL: ${pgEngines.length} version(s), ${formatBytes(totalPgSize)}`,
      ),
    )
  }
  if (mariadbEngines.length > 0) {
    console.log(
      chalk.gray(
        `  MariaDB: ${mariadbEngines.length} version(s), ${formatBytes(totalMariadbSize)}`,
      ),
    )
  }
  if (mysqlEngines.length > 0) {
    console.log(
      chalk.gray(
        `  MySQL: ${mysqlEngines.length} version(s), ${formatBytes(totalMysqlSize)}`,
      ),
    )
  }
  if (sqliteEngines.length > 0) {
    console.log(
      chalk.gray(
        `  SQLite: ${sqliteEngines.length} version(s), ${formatBytes(totalSqliteSize)}`,
      ),
    )
  }
  if (mongodbEngines.length > 0) {
    console.log(
      chalk.gray(
        `  MongoDB: ${mongodbEngines.length} version(s), ${formatBytes(totalMongodbSize)}`,
      ),
    )
  }
  if (redisEngines.length > 0) {
    console.log(
      chalk.gray(
        `  Redis: ${redisEngines.length} version(s), ${formatBytes(totalRedisSize)}`,
      ),
    )
  }
  if (valkeyEngines.length > 0) {
    console.log(
      chalk.gray(
        `  Valkey: ${valkeyEngines.length} version(s), ${formatBytes(totalValkeySize)}`,
      ),
    )
  }
  if (clickhouseEngines.length > 0) {
    console.log(
      chalk.gray(
        `  ClickHouse: ${clickhouseEngines.length} version(s), ${formatBytes(totalClickhouseSize)}`,
      ),
    )
  }
  console.log()

  const choices: MenuChoice[] = allEnginesSorted.map((e) => ({
    name: `${chalk.red('✕')} Delete ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
    value: `delete:${e.path}:${e.engine}:${e.version}`,
  }))

  choices.push(new inquirer.Separator())
  choices.push({ name: `${chalk.blue('←')} Back to main menu`, value: 'back' })

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'Manage engines:',
      choices,
      pageSize: 15,
    },
  ])

  if (action === 'back') {
    return
  }

  if (action.startsWith('delete:')) {
    // Parse from the end to preserve colons in path
    // Format: delete:path:engineName:engineVersion
    const withoutPrefix = action.slice('delete:'.length)
    const lastColon = withoutPrefix.lastIndexOf(':')
    const secondLastColon = withoutPrefix.lastIndexOf(':', lastColon - 1)
    const enginePath = withoutPrefix.slice(0, secondLastColon)
    const engineName = withoutPrefix.slice(secondLastColon + 1, lastColon)
    const engineVersion = withoutPrefix.slice(lastColon + 1)
    await handleDeleteEngine(enginePath, engineName, engineVersion)
    await handleEngines()
  }
}

async function handleDeleteEngine(
  enginePath: string,
  engineName: string,
  engineVersion: string,
): Promise<void> {
  const containers = await containerManager.list()
  const usingContainers = containers.filter(
    (c) => c.engine === engineName && c.version === engineVersion,
  )

  if (usingContainers.length > 0) {
    console.log()
    console.log(
      uiError(
        `Cannot delete: ${usingContainers.length} container(s) are using ${engineName} ${engineVersion}`,
      ),
    )
    console.log(
      chalk.gray(
        `  Containers: ${usingContainers.map((c) => c.name).join(', ')}`,
      ),
    )
    console.log()
    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('Press Enter to continue...'),
      },
    ])
    return
  }

  const confirmed = await promptConfirm(
    `Delete ${engineName} ${engineVersion}? This cannot be undone.`,
    false,
  )

  if (!confirmed) {
    console.log(uiWarning('Deletion cancelled'))
    return
  }

  const spinner = createSpinner(`Deleting ${engineName} ${engineVersion}...`)
  spinner.start()

  try {
    await rm(enginePath, { recursive: true, force: true })
    spinner.succeed(`Deleted ${engineName} ${engineVersion}`)
  } catch (error) {
    const e = error as Error
    spinner.fail(`Failed to delete: ${e.message}`)
  }
}
