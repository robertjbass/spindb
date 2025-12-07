import chalk from 'chalk'
import inquirer from 'inquirer'
import { rm } from 'fs/promises'
import { containerManager } from '../../../core/container-manager'
import { processManager } from '../../../core/process-manager'
import { createSpinner } from '../../ui/spinner'
import { header, error, warning, info, formatBytes } from '../../ui/theme'
import { promptConfirm } from '../../ui/prompts'
import { getEngineIcon, ENGINE_ICONS } from '../../constants'
import {
  getInstalledEngines,
  type InstalledPostgresEngine,
  type InstalledMysqlEngine,
  type InstalledSqliteEngine,
} from '../../helpers'
import {
  getMysqlVersion,
  getMysqlInstallInfo,
} from '../../../engines/mysql/binary-detection'

import { type MenuChoice } from './shared'

/**
 * Pad string to width, accounting for emoji taking 2 display columns
 */
function padWithEmoji(str: string, width: number): string {
  // Count emojis using Extended_Pictographic (excludes digits/symbols that \p{Emoji} matches)
  const emojiCount = (str.match(/\p{Extended_Pictographic}/gu) || []).length
  return str.padEnd(width + emojiCount)
}

export async function handleEngines(): Promise<void> {
  console.clear()
  console.log(header('Installed Engines'))
  console.log()

  const engines = await getInstalledEngines()

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

  const pgEngines = engines.filter(
    (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
  )
  const mysqlEngine = engines.find(
    (e): e is InstalledMysqlEngine => e.engine === 'mysql',
  )
  const sqliteEngine = engines.find(
    (e): e is InstalledSqliteEngine => e.engine === 'sqlite',
  )

  const totalPgSize = pgEngines.reduce((acc, e) => acc + e.sizeBytes, 0)

  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.bold.white('ENGINE'.padEnd(14)) +
      chalk.bold.white('VERSION'.padEnd(12)) +
      chalk.bold.white('SOURCE'.padEnd(18)) +
      chalk.bold.white('SIZE'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(55)))

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

  const choices: MenuChoice[] = []

  for (const e of pgEngines) {
    choices.push({
      name: `${chalk.red('✕')} Delete ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `delete:${e.path}:${e.engine}:${e.version}`,
    })
  }

  if (mysqlEngine) {
    const displayName = mysqlEngine.isMariaDB ? 'MariaDB' : 'MySQL'
    choices.push({
      name: `${chalk.blue('ℹ')} ${displayName} ${mysqlEngine.version} ${chalk.gray('(system-installed)')}`,
      value: `mysql-info:${mysqlEngine.path}`,
    })
  }

  if (sqliteEngine) {
    choices.push({
      name: `${chalk.blue('ℹ')} SQLite ${sqliteEngine.version} ${chalk.gray('(system-installed)')}`,
      value: `sqlite-info:${sqliteEngine.path}`,
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
    const mysqldPath = action.slice('mysql-info:'.length)
    await handleMysqlInfo(mysqldPath)
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
    console.log(warning('Deletion cancelled'))
    return
  }

  const spinner = createSpinner(`Deleting ${engineName} ${engineVersion}...`)
  spinner.start()

  try {
    await rm(enginePath, { recursive: true, force: true })
    spinner.succeed(`Deleted ${engineName} ${engineVersion}`)
  } catch (err) {
    const e = err as Error
    spinner.fail(`Failed to delete: ${e.message}`)
  }
}

async function handleMysqlInfo(mysqldPath: string): Promise<void> {
  console.clear()

  const installInfo = await getMysqlInstallInfo(mysqldPath)
  const displayName = installInfo.isMariaDB ? 'MariaDB' : 'MySQL'

  const version = await getMysqlVersion(mysqldPath)

  console.log(header(`${displayName} Information`))
  console.log()

  const containers = await containerManager.list()
  const mysqlContainers = containers.filter((c) => c.engine === 'mysql')

  const runningContainers: string[] = []

  if (mysqlContainers.length > 0) {
    console.log(
      warning(
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
      chalk.cyan(installInfo.packageManager),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Package Name:'.padEnd(18)) +
      chalk.cyan(installInfo.packageName),
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

  if (installInfo.packageManager === 'homebrew') {
    console.log(
      chalk.gray(
        `  # ${stepNum}. Stop Homebrew service (if running separately)`,
      ),
    )
    console.log(chalk.cyan(`  brew services stop ${installInfo.packageName}`))
    console.log()
    console.log(chalk.gray(`  # ${stepNum + 1}. Uninstall the package`))
    console.log(chalk.cyan(`  ${installInfo.uninstallCommand}`))
  } else if (installInfo.packageManager === 'apt') {
    console.log(chalk.gray(`  # ${stepNum}. Stop the system service`))
    console.log(
      chalk.cyan(
        `  sudo systemctl stop ${installInfo.isMariaDB ? 'mariadb' : 'mysql'}`,
      ),
    )
    console.log()
    console.log(chalk.gray(`  # ${stepNum + 1}. Disable auto-start on boot`))
    console.log(
      chalk.cyan(
        `  sudo systemctl disable ${installInfo.isMariaDB ? 'mariadb' : 'mysql'}`,
      ),
    )
    console.log()
    console.log(chalk.gray(`  # ${stepNum + 2}. Uninstall the package`))
    console.log(chalk.cyan(`  ${installInfo.uninstallCommand}`))
    console.log()
    console.log(chalk.gray(`  # ${stepNum + 3}. Remove data files (optional)`))
    console.log(
      chalk.cyan('  sudo apt purge mysql-server mysql-client mysql-common'),
    )
    console.log(chalk.cyan('  sudo rm -rf /var/lib/mysql /etc/mysql'))
  } else if (
    installInfo.packageManager === 'yum' ||
    installInfo.packageManager === 'dnf'
  ) {
    console.log(chalk.gray(`  # ${stepNum}. Stop the system service`))
    console.log(
      chalk.cyan(
        `  sudo systemctl stop ${installInfo.isMariaDB ? 'mariadb' : 'mysqld'}`,
      ),
    )
    console.log()
    console.log(chalk.gray(`  # ${stepNum + 1}. Uninstall the package`))
    console.log(chalk.cyan(`  ${installInfo.uninstallCommand}`))
  } else if (installInfo.packageManager === 'pacman') {
    console.log(chalk.gray(`  # ${stepNum}. Stop the system service`))
    console.log(
      chalk.cyan(
        `  sudo systemctl stop ${installInfo.isMariaDB ? 'mariadb' : 'mysqld'}`,
      ),
    )
    console.log()
    console.log(chalk.gray(`  # ${stepNum + 1}. Uninstall the package`))
    console.log(chalk.cyan(`  ${installInfo.uninstallCommand}`))
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
    console.log(info(`${sqliteContainers.length} SQLite database(s) registered:`))
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
  console.log(chalk.gray('  • SQLite is typically pre-installed on macOS and most Linux distributions'))
  console.log(chalk.gray('  • No server process - databases are just files'))
  console.log(chalk.gray('  • Use "spindb delete <name>" to unregister a database'))
  console.log()

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to go back...'),
    },
  ])
}
