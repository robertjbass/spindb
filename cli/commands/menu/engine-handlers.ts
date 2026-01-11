import chalk from 'chalk'
import inquirer from 'inquirer'
import { rm } from 'fs/promises'
import stringWidth from 'string-width'
import { containerManager } from '../../../core/container-manager'
import { createSpinner } from '../../ui/spinner'
import { header, uiError, uiWarning, uiInfo, formatBytes } from '../../ui/theme'
import { promptConfirm } from '../../ui/prompts'
import { getEngineIcon, ENGINE_ICONS } from '../../constants'
import {
  getInstalledEngines,
  type InstalledPostgresEngine,
  type InstalledMariadbEngine,
  type InstalledMysqlEngine,
  type InstalledSqliteEngine,
  type InstalledMongodbEngine,
  type InstalledRedisEngine,
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

  const pgEngines = engines.filter(
    (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
  )
  const mariadbEngines = engines.filter(
    (e): e is InstalledMariadbEngine => e.engine === 'mariadb',
  )
  const mysqlEngines = engines.filter(
    (e): e is InstalledMysqlEngine => e.engine === 'mysql',
  )
  const sqliteEngine = engines.find(
    (e): e is InstalledSqliteEngine => e.engine === 'sqlite',
  )
  const mongodbEngines = engines.filter(
    (e): e is InstalledMongodbEngine => e.engine === 'mongodb',
  )
  const redisEngines = engines.filter(
    (e): e is InstalledRedisEngine => e.engine === 'redis',
  )

  const totalPgSize = pgEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
  const totalMariadbSize = mariadbEngines.reduce(
    (acc, e) => acc + e.sizeBytes,
    0,
  )
  const totalMysqlSize = mysqlEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
  const totalMongodbSize = mongodbEngines.reduce(
    (acc, e) => acc + e.sizeBytes,
    0,
  )
  const totalRedisSize = redisEngines.reduce((acc, e) => acc + e.sizeBytes, 0)

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

  for (const engine of pgEngines) {
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

  for (const engine of mariadbEngines) {
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

  for (const engine of mysqlEngines) {
    const icon = ENGINE_ICONS.mysql
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

  if (sqliteEngine) {
    const icon = ENGINE_ICONS.sqlite
    const engineDisplay = `${icon} sqlite`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padToWidth(engineDisplay, COL_ENGINE)) +
        chalk.yellow(sqliteEngine.version.padEnd(COL_VERSION)) +
        chalk.gray('system'.padEnd(COL_SOURCE)) +
        chalk.gray('(system-installed)'),
    )
  }

  for (const engine of mongodbEngines) {
    const icon = ENGINE_ICONS.mongodb
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

  for (const engine of redisEngines) {
    const icon = ENGINE_ICONS.redis
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
  if (sqliteEngine) {
    console.log(
      chalk.gray(`  SQLite: system-installed at ${sqliteEngine.path}`),
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
  console.log()

  const choices: MenuChoice[] = []

  for (const e of pgEngines) {
    choices.push({
      name: `${chalk.red('✕')} Delete ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `delete:${e.path}:${e.engine}:${e.version}`,
    })
  }

  for (const e of mariadbEngines) {
    choices.push({
      name: `${chalk.red('✕')} Delete ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `delete:${e.path}:${e.engine}:${e.version}`,
    })
  }

  for (const e of mysqlEngines) {
    choices.push({
      name: `${chalk.red('✕')} Delete ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `delete:${e.path}:${e.engine}:${e.version}`,
    })
  }

  if (sqliteEngine) {
    choices.push({
      name: `${chalk.blue('ℹ')} SQLite ${sqliteEngine.version} ${chalk.gray('(system-installed)')}`,
      value: `sqlite-info:${sqliteEngine.path}`,
    })
  }

  for (const e of mongodbEngines) {
    choices.push({
      name: `${chalk.red('✕')} Delete ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `delete:${e.path}:${e.engine}:${e.version}`,
    })
  }

  for (const e of redisEngines) {
    choices.push({
      name: `${chalk.red('✕')} Delete ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `delete:${e.path}:${e.engine}:${e.version}`,
    })
  }

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

  if (action.startsWith('sqlite-info:')) {
    const sqlitePath = action.slice('sqlite-info:'.length)
    await handleSqliteInfo(sqlitePath)
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

async function handleSqliteInfo(sqlitePath: string): Promise<void> {
  console.clear()

  console.log(header('SQLite Information'))
  console.log()

  // Get version
  let version = 'unknown'
  try {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)
    const { stdout } = await execAsync(`"${sqlitePath}" --version`)
    const match = stdout.match(/^([\d.]+)/)
    if (match) {
      version = match[1]
    }
  } catch {
    // Ignore
  }

  const containers = await containerManager.list()
  const sqliteContainers = containers.filter((c) => c.engine === 'sqlite')

  if (sqliteContainers.length > 0) {
    console.log(
      uiInfo(`${sqliteContainers.length} SQLite database(s) registered:`),
    )
    console.log()
    for (const c of sqliteContainers) {
      const status =
        c.status === 'running'
          ? chalk.blue('🔵 available')
          : chalk.gray('⚪ missing')
      console.log(chalk.gray(`  • ${c.name} ${status}`))
    }
    console.log()
  }

  console.log(chalk.white('  Installation Details:'))
  console.log(chalk.gray('  ' + '─'.repeat(50)))
  console.log(
    chalk.gray('  ') +
      chalk.white('Version:'.padEnd(18)) +
      chalk.yellow(version),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Binary Path:'.padEnd(18)) +
      chalk.gray(sqlitePath),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Type:'.padEnd(18)) +
      chalk.cyan('Embedded (file-based)'),
  )
  console.log()

  console.log(chalk.white('  Notes:'))
  console.log(chalk.gray('  ' + '─'.repeat(50)))
  console.log(
    chalk.gray(
      '  • SQLite is typically pre-installed on macOS and most Linux distributions',
    ),
  )
  console.log(chalk.gray('  • No server process - databases are just files'))
  console.log(
    chalk.gray('  • Use "spindb delete <name>" to unregister a database'),
  )
  console.log()

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to go back...'),
    },
  ])
}
