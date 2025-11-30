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
} from '../../helpers'
import {
  getMysqlVersion,
  getMysqlInstallInfo,
} from '../../../engines/mysql/binary-detection'
import { type MenuChoice } from './shared'

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

  // Separate PostgreSQL and MySQL
  const pgEngines = engines.filter(
    (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
  )
  const mysqlEngine = engines.find(
    (e): e is InstalledMysqlEngine => e.engine === 'mysql',
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

    console.log(
      chalk.gray('  ') +
        chalk.cyan(`${icon} ${engine.engine}`.padEnd(13)) +
        chalk.yellow(engine.version.padEnd(12)) +
        chalk.gray(platformInfo.padEnd(18)) +
        chalk.white(formatBytes(engine.sizeBytes)),
    )
  }

  // MySQL row
  if (mysqlEngine) {
    const icon = ENGINE_ICONS.mysql
    const displayName = mysqlEngine.isMariaDB ? 'mariadb' : 'mysql'

    console.log(
      chalk.gray('  ') +
        chalk.cyan(`${icon} ${displayName}`.padEnd(13)) +
        chalk.yellow(mysqlEngine.version.padEnd(12)) +
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
  console.log()

  // Menu options - only allow deletion of PostgreSQL engines
  const choices: MenuChoice[] = []

  for (const e of pgEngines) {
    choices.push({
      name: `${chalk.red('✕')} Delete ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `delete:${e.path}:${e.engine}:${e.version}`,
    })
  }

  // MySQL info option (not disabled, shows info icon)
  if (mysqlEngine) {
    const displayName = mysqlEngine.isMariaDB ? 'MariaDB' : 'MySQL'
    choices.push({
      name: `${chalk.blue('ℹ')} ${displayName} ${mysqlEngine.version} ${chalk.gray('(system-installed)')}`,
      value: `mysql-info:${mysqlEngine.path}`,
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
    const [, enginePath, engineName, engineVersion] = action.split(':')
    await handleDeleteEngine(enginePath, engineName, engineVersion)
    // Return to engines menu
    await handleEngines()
  }

  if (action.startsWith('mysql-info:')) {
    const mysqldPath = action.replace('mysql-info:', '')
    await handleMysqlInfo(mysqldPath)
    // Return to engines menu
    await handleEngines()
  }
}

async function handleDeleteEngine(
  enginePath: string,
  engineName: string,
  engineVersion: string,
): Promise<void> {
  // Check if any container is using this engine version
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

  // Get install info
  const installInfo = await getMysqlInstallInfo(mysqldPath)
  const displayName = installInfo.isMariaDB ? 'MariaDB' : 'MySQL'

  // Get version
  const version = await getMysqlVersion(mysqldPath)

  console.log(header(`${displayName} Information`))
  console.log()

  // Check for containers using MySQL
  const containers = await containerManager.list()
  const mysqlContainers = containers.filter((c) => c.engine === 'mysql')

  // Track running containers for uninstall instructions
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

  // Show installation details
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

  // Uninstall instructions
  console.log(chalk.white('  To uninstall:'))
  console.log(chalk.gray('  ' + '─'.repeat(50)))

  let stepNum = 1

  // Step: Stop running containers first
  if (runningContainers.length > 0) {
    console.log(chalk.gray(`  # ${stepNum}. Stop running SpinDB containers`))
    console.log(chalk.cyan('  spindb stop <container-name>'))
    console.log()
    stepNum++
  }

  // Step: Delete SpinDB containers
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

  // Wait for user
  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to go back...'),
    },
  ])
}
