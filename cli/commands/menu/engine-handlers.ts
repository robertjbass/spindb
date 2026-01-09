import chalk from 'chalk'
import inquirer from 'inquirer'
import { rm } from 'fs/promises'
import stringWidth from 'string-width'
import { containerManager } from '../../../core/container-manager'
import { processManager } from '../../../core/process-manager'
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
import { getMysqlVersion } from '../../../engines/mysql/binary-detection'
import { getMongodVersion } from '../../../engines/mongodb/binary-detection'
import { getRedisVersion } from '../../../engines/redis/binary-detection'

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
  const totalMariadbSize = mariadbEngines.reduce((acc, e) => acc + e.sizeBytes, 0)

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

  for (const mysqlEngine of mysqlEngines) {
    const icon = ENGINE_ICONS.mysql
    const displayName = mysqlEngine.isMariaDB ? 'mariadb' : 'mysql'
    const engineDisplay = `${icon} ${displayName}`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padToWidth(engineDisplay, COL_ENGINE)) +
        chalk.yellow(mysqlEngine.version.padEnd(COL_VERSION)) +
        chalk.gray('system'.padEnd(COL_SOURCE)) +
        chalk.gray('(system-installed)'),
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

  for (const mongodbEngine of mongodbEngines) {
    const icon = ENGINE_ICONS.mongodb
    const engineDisplay = `${icon} mongodb`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padToWidth(engineDisplay, COL_ENGINE)) +
        chalk.yellow(mongodbEngine.version.padEnd(COL_VERSION)) +
        chalk.gray('system'.padEnd(COL_SOURCE)) +
        chalk.gray('(system-installed)'),
    )
  }

  for (const redisEngine of redisEngines) {
    const icon = ENGINE_ICONS.redis
    const engineDisplay = `${icon} redis`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padToWidth(engineDisplay, COL_ENGINE)) +
        chalk.yellow(redisEngine.version.padEnd(COL_VERSION)) +
        chalk.gray('system'.padEnd(COL_SOURCE)) +
        chalk.gray('(system-installed)'),
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
    const versionCount = mysqlEngines.length
    const versionText = versionCount === 1 ? 'version' : 'versions'
    console.log(
      chalk.gray(`  MySQL: ${versionCount} ${versionText} system-installed`),
    )
  }
  if (sqliteEngine) {
    console.log(
      chalk.gray(`  SQLite: system-installed at ${sqliteEngine.path}`),
    )
  }
  if (mongodbEngines.length > 0) {
    const versionCount = mongodbEngines.length
    const versionText = versionCount === 1 ? 'version' : 'versions'
    console.log(
      chalk.gray(`  MongoDB: ${versionCount} ${versionText} system-installed`),
    )
  }
  if (redisEngines.length > 0) {
    const versionCount = redisEngines.length
    const versionText = versionCount === 1 ? 'version' : 'versions'
    console.log(
      chalk.gray(`  Redis: ${versionCount} ${versionText} system-installed`),
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

  for (const mysqlEngine of mysqlEngines) {
    const displayName = mysqlEngine.isMariaDB ? 'MariaDB' : 'MySQL'
    // Show formula name if it's a versioned install
    const versionLabel =
      mysqlEngine.formulaName !== 'mysql' && mysqlEngine.formulaName !== 'mariadb'
        ? ` (${mysqlEngine.formulaName})`
        : ''
    choices.push({
      name: `${chalk.blue('ℹ')} ${displayName} ${mysqlEngine.version}${versionLabel} ${chalk.gray('(system-installed)')}`,
      value: `mysql-info:${mysqlEngine.path}:${mysqlEngine.formulaName}`,
    })
  }

  if (sqliteEngine) {
    choices.push({
      name: `${chalk.blue('ℹ')} SQLite ${sqliteEngine.version} ${chalk.gray('(system-installed)')}`,
      value: `sqlite-info:${sqliteEngine.path}`,
    })
  }

  for (const mongodbEngine of mongodbEngines) {
    // Show formula name if it's a versioned install
    const versionLabel =
      mongodbEngine.formulaName !== 'mongodb-community'
        ? ` (${mongodbEngine.formulaName})`
        : ''
    choices.push({
      name: `${chalk.blue('ℹ')} MongoDB ${mongodbEngine.version}${versionLabel} ${chalk.gray('(system-installed)')}`,
      value: `mongodb-info:${mongodbEngine.path}:${mongodbEngine.formulaName}`,
    })
  }

  for (const redisEngine of redisEngines) {
    // Show formula name if it's a versioned install
    const versionLabel =
      redisEngine.formulaName !== 'redis'
        ? ` (${redisEngine.formulaName})`
        : ''
    choices.push({
      name: `${chalk.blue('ℹ')} Redis ${redisEngine.version}${versionLabel} ${chalk.gray('(system-installed)')}`,
      value: `redis-info:${redisEngine.path}:${redisEngine.formulaName}`,
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

  if (action.startsWith('mysql-info:')) {
    // Format: mysql-info:path:formulaName
    const withoutPrefix = action.slice('mysql-info:'.length)
    const lastColon = withoutPrefix.lastIndexOf(':')
    const mysqldPath = withoutPrefix.slice(0, lastColon)
    const formulaName = withoutPrefix.slice(lastColon + 1)
    await handleMysqlInfo(mysqldPath, formulaName)
    await handleEngines()
  }

  if (action.startsWith('sqlite-info:')) {
    const sqlitePath = action.slice('sqlite-info:'.length)
    await handleSqliteInfo(sqlitePath)
    await handleEngines()
  }

  if (action.startsWith('mongodb-info:')) {
    // Format: mongodb-info:path:formulaName
    const withoutPrefix = action.slice('mongodb-info:'.length)
    const lastColon = withoutPrefix.lastIndexOf(':')
    const mongodPath = withoutPrefix.slice(0, lastColon)
    const formulaName = withoutPrefix.slice(lastColon + 1)
    await handleMongodbInfo(mongodPath, formulaName)
    await handleEngines()
  }

  if (action.startsWith('redis-info:')) {
    // Format: redis-info:path:formulaName
    const withoutPrefix = action.slice('redis-info:'.length)
    const lastColon = withoutPrefix.lastIndexOf(':')
    const redisPath = withoutPrefix.slice(0, lastColon)
    const formulaName = withoutPrefix.slice(lastColon + 1)
    await handleRedisInfo(redisPath, formulaName)
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

async function handleMysqlInfo(
  mysqldPath: string,
  formulaName: string,
): Promise<void> {
  console.clear()

  const isMariaDB = formulaName.includes('mariadb')
  const displayName = isMariaDB ? 'MariaDB' : 'MySQL'

  let version = 'unknown'
  try {
    version = (await getMysqlVersion(mysqldPath)) ?? 'unknown'
  } catch {
    // Ignore - version will remain 'unknown'
  }

  console.log(header(`${displayName} Information`))
  console.log()

  const containers = await containerManager.list()
  const mysqlContainers = containers.filter((c) => c.engine === 'mysql')

  const runningContainers: string[] = []

  if (mysqlContainers.length > 0) {
    console.log(
      uiWarning(
        `${mysqlContainers.length} container(s) are using ${displayName}:`,
      ),
    )
    console.log()
    for (const c of mysqlContainers) {
      const isRunning = await processManager.isRunning(c.name, {
        engine: c.engine,
      })
      if (isRunning) {
        runningContainers.push(c.name)
      }
      const status = isRunning
        ? chalk.green('● running')
        : chalk.gray('○ stopped')
      console.log(chalk.gray(`  • ${c.name} ${status}`))
    }
    console.log()
    console.log(
      chalk.yellow(
        '  Uninstalling will break these containers. Delete them first.',
      ),
    )
    console.log()
  }

  // Detect package manager from path
  const isHomebrew =
    mysqldPath.includes('/opt/homebrew/') ||
    mysqldPath.includes('/usr/local/opt/') ||
    mysqldPath.includes('/usr/local/Cellar/')
  const packageManager = isHomebrew ? 'homebrew' : 'system'

  console.log(chalk.white('  Installation Details:'))
  console.log(chalk.gray('  ' + '─'.repeat(50)))
  console.log(
    chalk.gray('  ') +
      chalk.white('Version:'.padEnd(18)) +
      chalk.yellow(version || 'unknown'),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Binary Path:'.padEnd(18)) +
      chalk.gray(mysqldPath),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Package Manager:'.padEnd(18)) +
      chalk.cyan(packageManager),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Package Name:'.padEnd(18)) +
      chalk.cyan(formulaName),
  )
  console.log()

  console.log(chalk.white('  To uninstall:'))
  console.log(chalk.gray('  ' + '─'.repeat(50)))

  let stepNum = 1

  if (runningContainers.length > 0) {
    console.log(chalk.gray(`  # ${stepNum}. Stop running SpinDB containers`))
    console.log(chalk.cyan('  spindb stop <container-name>'))
    console.log()
    stepNum++
  }

  if (mysqlContainers.length > 0) {
    console.log(chalk.gray(`  # ${stepNum}. Delete SpinDB containers`))
    console.log(chalk.cyan('  spindb delete <container-name>'))
    console.log()
    stepNum++
  }

  if (isHomebrew) {
    console.log(
      chalk.gray(
        `  # ${stepNum}. Stop Homebrew service (if running separately)`,
      ),
    )
    console.log(chalk.cyan(`  brew services stop ${formulaName}`))
    console.log()
    console.log(chalk.gray(`  # ${stepNum + 1}. Uninstall the package`))
    console.log(chalk.cyan(`  brew uninstall ${formulaName}`))
  } else {
    console.log(chalk.gray('  Use your system package manager to uninstall.'))
    console.log(chalk.gray(`  The binary is located at: ${mysqldPath}`))
  }

  console.log()

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to go back...'),
    },
  ])
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

async function handleMongodbInfo(
  mongodPath: string,
  formulaName: string,
): Promise<void> {
  console.clear()

  console.log(header('MongoDB Information'))
  console.log()

  let version = 'unknown'
  try {
    version = (await getMongodVersion(mongodPath)) ?? 'unknown'
  } catch {
    // Ignore - version will remain 'unknown'
  }

  const containers = await containerManager.list()
  const mongodbContainers = containers.filter((c) => c.engine === 'mongodb')

  const runningContainers: string[] = []

  if (mongodbContainers.length > 0) {
    console.log(uiInfo(`${mongodbContainers.length} MongoDB container(s):`))
    console.log()
    for (const c of mongodbContainers) {
      const isRunning = await processManager.isRunning(c.name, {
        engine: c.engine,
      })
      if (isRunning) {
        runningContainers.push(c.name)
      }
      const status = isRunning
        ? chalk.green('● running')
        : chalk.gray('○ stopped')
      console.log(chalk.gray(`  • ${c.name} ${status}`))
    }
    console.log()
  }

  // Detect package manager from path
  const isHomebrew =
    mongodPath.includes('/opt/homebrew/') ||
    mongodPath.includes('/usr/local/opt/') ||
    mongodPath.includes('/usr/local/Cellar/')
  const packageManager = isHomebrew ? 'homebrew' : 'system'

  console.log(chalk.white('  Installation Details:'))
  console.log(chalk.gray('  ' + '─'.repeat(50)))
  console.log(
    chalk.gray('  ') +
      chalk.white('Version:'.padEnd(18)) +
      chalk.yellow(version || 'unknown'),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Binary Path:'.padEnd(18)) +
      chalk.gray(mongodPath),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Package Manager:'.padEnd(18)) +
      chalk.cyan(packageManager),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Package Name:'.padEnd(18)) +
      chalk.cyan(formulaName),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Type:'.padEnd(18)) +
      chalk.cyan('Document database (NoSQL)'),
  )
  console.log()

  console.log(chalk.white('  To uninstall:'))
  console.log(chalk.gray('  ' + '─'.repeat(50)))

  let stepNum = 1

  if (runningContainers.length > 0) {
    console.log(chalk.gray(`  # ${stepNum}. Stop running SpinDB containers`))
    console.log(chalk.cyan('  spindb stop <container-name>'))
    console.log()
    stepNum++
  }

  if (mongodbContainers.length > 0) {
    console.log(chalk.gray(`  # ${stepNum}. Delete SpinDB containers`))
    console.log(chalk.cyan('  spindb delete <container-name>'))
    console.log()
    stepNum++
  }

  if (isHomebrew) {
    console.log(chalk.gray(`  # ${stepNum}. Uninstall via Homebrew`))
    console.log(chalk.cyan(`  brew services stop ${formulaName}`))
    console.log(chalk.cyan(`  brew uninstall ${formulaName}`))
    console.log(chalk.cyan('  brew uninstall mongosh mongodb-database-tools'))
  } else {
    console.log(chalk.gray('  Use your system package manager to uninstall.'))
    console.log(chalk.gray(`  The binary is located at: ${mongodPath}`))
  }

  console.log()

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to go back...'),
    },
  ])
}

async function handleRedisInfo(
  redisServerPath: string,
  formulaName: string,
): Promise<void> {
  console.clear()

  console.log(header('Redis Information'))
  console.log()

  let version = 'unknown'
  try {
    version = (await getRedisVersion(redisServerPath)) ?? 'unknown'
  } catch {
    // Ignore - version will remain 'unknown'
  }

  const containers = await containerManager.list()
  const redisContainers = containers.filter((c) => c.engine === 'redis')

  const runningContainers: string[] = []

  if (redisContainers.length > 0) {
    console.log(uiInfo(`${redisContainers.length} Redis container(s):`))
    console.log()
    for (const c of redisContainers) {
      const isRunning = await processManager.isRunning(c.name, {
        engine: c.engine,
      })
      if (isRunning) {
        runningContainers.push(c.name)
      }
      const status = isRunning
        ? chalk.green('● running')
        : chalk.gray('○ stopped')
      console.log(chalk.gray(`  • ${c.name} ${status}`))
    }
    console.log()
  }

  // Detect package manager from path
  const isHomebrew =
    redisServerPath.includes('/opt/homebrew/') ||
    redisServerPath.includes('/usr/local/opt/') ||
    redisServerPath.includes('/usr/local/Cellar/')
  const packageManager = isHomebrew ? 'homebrew' : 'system'

  console.log(chalk.white('  Installation Details:'))
  console.log(chalk.gray('  ' + '─'.repeat(50)))
  console.log(
    chalk.gray('  ') +
      chalk.white('Version:'.padEnd(18)) +
      chalk.yellow(version || 'unknown'),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Binary Path:'.padEnd(18)) +
      chalk.gray(redisServerPath),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Package Manager:'.padEnd(18)) +
      chalk.cyan(packageManager),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Package Name:'.padEnd(18)) +
      chalk.cyan(formulaName),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Type:'.padEnd(18)) +
      chalk.cyan('In-memory data store'),
  )
  console.log()

  console.log(chalk.white('  To uninstall:'))
  console.log(chalk.gray('  ' + '─'.repeat(50)))

  let stepNum = 1

  if (runningContainers.length > 0) {
    console.log(chalk.gray(`  # ${stepNum}. Stop running SpinDB containers`))
    console.log(chalk.cyan('  spindb stop <container-name>'))
    console.log()
    stepNum++
  }

  if (redisContainers.length > 0) {
    console.log(chalk.gray(`  # ${stepNum}. Delete SpinDB containers`))
    console.log(chalk.cyan('  spindb delete <container-name>'))
    console.log()
    stepNum++
  }

  if (isHomebrew) {
    console.log(chalk.gray(`  # ${stepNum}. Uninstall via Homebrew`))
    console.log(chalk.cyan(`  brew services stop ${formulaName}`))
    console.log(chalk.cyan(`  brew uninstall ${formulaName}`))
  } else {
    console.log(chalk.gray('  Use your system package manager to uninstall.'))
    console.log(chalk.gray(`  The binary is located at: ${redisServerPath}`))
  }

  console.log()

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to go back...'),
    },
  ])
}
