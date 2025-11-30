import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import {
  promptContainerSelect,
  promptContainerName,
  promptDatabaseName,
  promptDatabaseSelect,
  promptBackupFormat,
  promptBackupFilename,
  promptCreateOptions,
  promptConfirm,
  promptInstallDependencies,
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import {
  header,
  success,
  error,
  warning,
  info,
  connectionBox,
  formatBytes,
} from '../ui/theme'
import { existsSync } from 'fs'
import { readdir, rm, lstat } from 'fs/promises'
import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { join } from 'path'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'
import { portManager } from '../../core/port-manager'
import { defaults } from '../../config/defaults'
import { getPostgresHomebrewPackage } from '../../config/engine-defaults'
import { Engine } from '../../types'
import inquirer from 'inquirer'
import {
  getMissingDependencies,
  isUsqlInstalled,
  isPgcliInstalled,
  isMycliInstalled,
  detectPackageManager,
  installUsql,
  installPgcli,
  installMycli,
  getUsqlManualInstructions,
  getPgcliManualInstructions,
  getMycliManualInstructions,
} from '../../core/dependency-manager'
import {
  getMysqldPath,
  getMysqlVersion,
  isMariaDB,
  getMysqlInstallInfo,
} from '../../engines/mysql/binary-detection'
import { updateManager } from '../../core/update-manager'

type MenuChoice =
  | {
      name: string
      value: string
      disabled?: boolean | string
    }
  | inquirer.Separator

/**
 * Engine icons for display
 */
const engineIcons: Record<string, string> = {
  postgresql: '🐘',
  mysql: '🐬',
}

/**
 * Helper to pause and wait for user to press Enter
 */
async function pressEnterToContinue(): Promise<void> {
  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to continue...'),
    },
  ])
}

async function showMainMenu(): Promise<void> {
  console.clear()
  console.log(header('SpinDB - Local Database Manager'))
  console.log()

  const containers = await containerManager.list()
  const running = containers.filter((c) => c.status === 'running').length
  const stopped = containers.filter((c) => c.status !== 'running').length

  console.log(
    chalk.gray(
      `  ${containers.length} container(s): ${running} running, ${stopped} stopped`,
    ),
  )
  console.log()

  const canStart = stopped > 0
  const canStop = running > 0
  const canRestore = running > 0
  const canClone = containers.length > 0

  // Check if any engines are installed
  const engines = await getInstalledEngines()
  const hasEngines = engines.length > 0

  // If containers exist, show List first; otherwise show Create first
  const hasContainers = containers.length > 0

  const choices: MenuChoice[] = [
    ...(hasContainers
      ? [
          { name: `${chalk.cyan('◉')} Containers`, value: 'list' },
          { name: `${chalk.green('+')} Create new container`, value: 'create' },
        ]
      : [
          { name: `${chalk.green('+')} Create new container`, value: 'create' },
          { name: `${chalk.cyan('◉')} Containers`, value: 'list' },
        ]),
    {
      name: canStart
        ? `${chalk.green('▶')} Start a container`
        : chalk.gray('▶ Start a container'),
      value: 'start',
      disabled: canStart ? false : 'No stopped containers',
    },
    {
      name: canStop
        ? `${chalk.red('■')} Stop a container`
        : chalk.gray('■ Stop a container'),
      value: 'stop',
      disabled: canStop ? false : 'No running containers',
    },
    {
      name: canRestore
        ? `${chalk.magenta('↓')} Restore backup`
        : chalk.gray('↓ Restore backup'),
      value: 'restore',
      disabled: canRestore ? false : 'No running containers',
    },
    {
      name: canRestore
        ? `${chalk.magenta('↑')} Backup database`
        : chalk.gray('↑ Backup database'),
      value: 'backup',
      disabled: canRestore ? false : 'No running containers',
    },
    {
      name: canClone
        ? `${chalk.cyan('⧉')} Clone a container`
        : chalk.gray('⧉ Clone a container'),
      value: 'clone',
      disabled: canClone ? false : 'No containers',
    },
    {
      name: hasEngines
        ? `${chalk.yellow('⚙')} List installed engines`
        : chalk.gray('⚙ List installed engines'),
      value: 'engines',
      disabled: hasEngines ? false : 'No engines installed',
    },
    new inquirer.Separator(),
    { name: `${chalk.cyan('↑')} Check for updates`, value: 'check-update' },
    { name: `${chalk.gray('⏻')} Exit`, value: 'exit' },
  ]

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices,
      pageSize: 12,
    },
  ])

  switch (action) {
    case 'create':
      await handleCreate()
      break
    case 'list':
      await handleList()
      break
    case 'start':
      await handleStart()
      break
    case 'stop':
      await handleStop()
      break
    case 'restore':
      await handleRestore()
      break
    case 'backup':
      await handleBackup()
      break
    case 'clone':
      await handleClone()
      break
    case 'engines':
      await handleEngines()
      break
    case 'check-update':
      await handleCheckUpdate()
      break
    case 'exit':
      console.log(chalk.gray('\n  Goodbye!\n'))
      process.exit(0)
  }

  // Return to menu after action
  await showMainMenu()
}

async function handleCheckUpdate(): Promise<void> {
  console.clear()
  console.log(header('Check for Updates'))
  console.log()

  const spinner = createSpinner('Checking for updates...')
  spinner.start()

  const result = await updateManager.checkForUpdate(true)

  if (!result) {
    spinner.fail('Could not reach npm registry')
    console.log()
    console.log(info('Check your internet connection and try again.'))
    console.log(chalk.gray('  Manual update: npm install -g spindb@latest'))
    console.log()
    await pressEnterToContinue()
    return
  }

  if (result.updateAvailable) {
    spinner.succeed('Update available')
    console.log()
    console.log(chalk.gray(`  Current version: ${result.currentVersion}`))
    console.log(
      chalk.gray(`  Latest version:  ${chalk.green(result.latestVersion)}`),
    )
    console.log()

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Update now', value: 'update' },
          { name: 'Remind me later', value: 'later' },
          { name: "Don't check for updates on startup", value: 'disable' },
        ],
      },
    ])

    if (action === 'update') {
      console.log()
      const updateSpinner = createSpinner('Updating spindb...')
      updateSpinner.start()

      const updateResult = await updateManager.performUpdate()

      if (updateResult.success) {
        updateSpinner.succeed('Update complete')
        console.log()
        console.log(
          success(
            `Updated from ${updateResult.previousVersion} to ${updateResult.newVersion}`,
          ),
        )
        console.log()
        if (updateResult.previousVersion !== updateResult.newVersion) {
          console.log(warning('Please restart spindb to use the new version.'))
          console.log()
        }
      } else {
        updateSpinner.fail('Update failed')
        console.log()
        console.log(error(updateResult.error || 'Unknown error'))
        console.log()
        console.log(info('Manual update: npm install -g spindb@latest'))
      }
      await pressEnterToContinue()
    } else if (action === 'disable') {
      await updateManager.setAutoCheckEnabled(false)
      console.log()
      console.log(info('Update checks disabled on startup.'))
      console.log(chalk.gray('  Re-enable with: spindb config update-check on'))
      console.log()
      await pressEnterToContinue()
    }
    // 'later' just returns to menu
  } else {
    spinner.succeed('You are on the latest version')
    console.log()
    console.log(chalk.gray(`  Version: ${result.currentVersion}`))
    console.log()
    await pressEnterToContinue()
  }
}

async function handleCreate(): Promise<void> {
  console.log()
  const answers = await promptCreateOptions()
  let { name: containerName } = answers
  const { engine, version, port, database } = answers

  console.log()
  console.log(header('Creating Database Container'))
  console.log()

  const dbEngine = getEngine(engine)

  // Check for required client tools BEFORE creating anything
  const depsSpinner = createSpinner('Checking required tools...')
  depsSpinner.start()

  let missingDeps = await getMissingDependencies(engine)
  if (missingDeps.length > 0) {
    depsSpinner.warn(
      `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
    )

    // Offer to install
    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      engine,
    )

    if (!installed) {
      return
    }

    // Verify installation worked
    missingDeps = await getMissingDependencies(engine)
    if (missingDeps.length > 0) {
      console.log(
        error(
          `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
        ),
      )
      return
    }

    console.log(chalk.green('  ✓ All required tools are now available'))
    console.log()
  } else {
    depsSpinner.succeed('Required tools available')
  }

  // Check if port is currently in use
  const portAvailable = await portManager.isPortAvailable(port)

  // Ensure binaries
  const binarySpinner = createSpinner(
    `Checking PostgreSQL ${version} binaries...`,
  )
  binarySpinner.start()

  const isInstalled = await dbEngine.isBinaryInstalled(version)
  if (isInstalled) {
    binarySpinner.succeed(`PostgreSQL ${version} binaries ready (cached)`)
  } else {
    binarySpinner.text = `Downloading PostgreSQL ${version} binaries...`
    await dbEngine.ensureBinaries(version, ({ message }) => {
      binarySpinner.text = message
    })
    binarySpinner.succeed(`PostgreSQL ${version} binaries downloaded`)
  }

  // Check if container name already exists and prompt for new name if needed
  while (await containerManager.exists(containerName)) {
    console.log(chalk.yellow(`  Container "${containerName}" already exists.`))
    containerName = await promptContainerName()
  }

  // Create container
  const createSpinnerInstance = createSpinner('Creating container...')
  createSpinnerInstance.start()

  await containerManager.create(containerName, {
    engine: dbEngine.name as Engine,
    version,
    port,
    database,
  })

  createSpinnerInstance.succeed('Container created')

  // Initialize database cluster
  const initSpinner = createSpinner('Initializing database cluster...')
  initSpinner.start()

  await dbEngine.initDataDir(containerName, version, {
    superuser: defaults.superuser,
  })

  initSpinner.succeed('Database cluster initialized')

  // Start container (only if port is available)
  if (portAvailable) {
    const startSpinner = createSpinner('Starting PostgreSQL...')
    startSpinner.start()

    const config = await containerManager.getConfig(containerName)
    if (config) {
      await dbEngine.start(config)
      await containerManager.updateConfig(containerName, { status: 'running' })
    }

    startSpinner.succeed('PostgreSQL started')

    // Create the user's database (if different from 'postgres')
    if (config && database !== 'postgres') {
      const dbSpinner = createSpinner(`Creating database "${database}"...`)
      dbSpinner.start()

      await dbEngine.createDatabase(config, database)

      dbSpinner.succeed(`Database "${database}" created`)
    }

    // Show success
    if (config) {
      const connectionString = dbEngine.getConnectionString(config)
      console.log()
      console.log(success('Database Created'))
      console.log()
      console.log(chalk.gray(`  Container: ${containerName}`))
      console.log(chalk.gray(`  Engine: ${dbEngine.name} ${version}`))
      console.log(chalk.gray(`  Database: ${database}`))
      console.log(chalk.gray(`  Port: ${port}`))
      console.log()
      console.log(success(`Started Running on port ${port}`))
      console.log()
      console.log(chalk.gray('  Connection string:'))
      console.log(chalk.cyan(`  ${connectionString}`))

      // Copy connection string to clipboard using platform service
      try {
        const copied = await platformService.copyToClipboard(connectionString)
        if (copied) {
          console.log(chalk.gray('  ✓ Connection string copied to clipboard'))
        } else {
          console.log(chalk.gray('  (Could not copy to clipboard)'))
        }
      } catch {
        console.log(chalk.gray('  (Could not copy to clipboard)'))
      }

      console.log()

      // Wait for user to see the result before returning to menu
      await inquirer.prompt([
        {
          type: 'input',
          name: 'continue',
          message: chalk.gray('Press Enter to return to the main menu...'),
        },
      ])
    }
  } else {
    console.log()
    console.log(
      warning(
        `Port ${port} is currently in use. Container created but not started.`,
      ),
    )
    console.log(
      info(
        `Start it later with: ${chalk.cyan(`spindb start ${containerName}`)}`,
      ),
    )
  }
}

async function handleList(): Promise<void> {
  console.clear()
  console.log(header('Containers'))
  console.log()
  const containers = await containerManager.list()

  if (containers.length === 0) {
    console.log(
      info('No containers found. Create one with the "Create" option.'),
    )
    console.log()

    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('Press Enter to return to the main menu...'),
      },
    ])
    return
  }

  // Fetch sizes for running containers in parallel
  const sizes = await Promise.all(
    containers.map(async (container) => {
      if (container.status !== 'running') return null
      try {
        const engine = getEngine(container.engine)
        return await engine.getDatabaseSize(container)
      } catch {
        return null
      }
    }),
  )

  // Table header
  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.bold.white('NAME'.padEnd(20)) +
      chalk.bold.white('ENGINE'.padEnd(12)) +
      chalk.bold.white('VERSION'.padEnd(10)) +
      chalk.bold.white('PORT'.padEnd(8)) +
      chalk.bold.white('SIZE'.padEnd(10)) +
      chalk.bold.white('STATUS'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(70)))

  // Table rows
  for (let i = 0; i < containers.length; i++) {
    const container = containers[i]
    const size = sizes[i]

    const statusDisplay =
      container.status === 'running'
        ? chalk.green('● running')
        : chalk.gray('○ stopped')

    const sizeDisplay = size !== null ? formatBytes(size) : chalk.gray('—')

    console.log(
      chalk.gray('  ') +
        chalk.cyan(container.name.padEnd(20)) +
        chalk.white(container.engine.padEnd(12)) +
        chalk.yellow(container.version.padEnd(10)) +
        chalk.green(String(container.port).padEnd(8)) +
        chalk.magenta(sizeDisplay.padEnd(10)) +
        statusDisplay,
    )
  }

  console.log()

  const running = containers.filter((c) => c.status === 'running').length
  const stopped = containers.filter((c) => c.status !== 'running').length
  console.log(
    chalk.gray(
      `  ${containers.length} container(s): ${running} running, ${stopped} stopped`,
    ),
  )

  // Container selection with submenu
  console.log()
  const containerChoices = [
    ...containers.map((c, i) => {
      const size = sizes[i]
      const sizeLabel = size !== null ? `, ${formatBytes(size)}` : ''
      return {
        name: `${c.name} ${chalk.gray(`(${engineIcons[c.engine] || '▣'} ${c.engine} ${c.version}, port ${c.port}${sizeLabel})`)} ${
          c.status === 'running'
            ? chalk.green('● running')
            : chalk.gray('○ stopped')
        }`,
        value: c.name,
        short: c.name,
      }
    }),
    new inquirer.Separator(),
    { name: `${chalk.blue('←')} Back to main menu`, value: 'back' },
  ]

  const { selectedContainer } = await inquirer.prompt<{
    selectedContainer: string
  }>([
    {
      type: 'list',
      name: 'selectedContainer',
      message: 'Select a container for more options:',
      choices: containerChoices,
      pageSize: 15,
    },
  ])

  if (selectedContainer === 'back') {
    await showMainMenu()
    return
  }

  await showContainerSubmenu(selectedContainer)
}

async function showContainerSubmenu(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  // Check actual running state
  const isRunning = await processManager.isRunning(containerName, {
    engine: config.engine,
  })
  const status = isRunning ? 'running' : 'stopped'

  console.clear()
  console.log(header(containerName))
  console.log()
  console.log(
    chalk.gray(
      `  ${config.engine} ${config.version} on port ${config.port} - ${status}`,
    ),
  )
  console.log()

  const actionChoices: MenuChoice[] = [
    // Start or Stop depending on current state
    !isRunning
      ? { name: `${chalk.green('▶')} Start container`, value: 'start' }
      : { name: `${chalk.red('■')} Stop container`, value: 'stop' },
    {
      name: isRunning
        ? `${chalk.blue('⌘')} Open shell`
        : chalk.gray('⌘ Open shell'),
      value: 'shell',
      disabled: isRunning ? false : 'Start container first',
    },
    {
      name: !isRunning
        ? `${chalk.white('⚙')} Edit container`
        : chalk.gray('⚙ Edit container'),
      value: 'edit',
      disabled: !isRunning ? false : 'Stop container first',
    },
    {
      name: !isRunning
        ? `${chalk.cyan('⧉')} Clone container`
        : chalk.gray('⧉ Clone container'),
      value: 'clone',
      disabled: !isRunning ? false : 'Stop container first',
    },
    { name: `${chalk.magenta('⎘')} Copy connection string`, value: 'copy' },
    {
      name: !isRunning
        ? `${chalk.red('✕')} Delete container`
        : chalk.gray('✕ Delete container'),
      value: 'delete',
      disabled: !isRunning ? false : 'Stop container first',
    },
    new inquirer.Separator(),
    { name: `${chalk.blue('←')} Back to containers`, value: 'back' },
    { name: `${chalk.blue('⌂')} Back to main menu`, value: 'main' },
  ]

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: actionChoices,
      pageSize: 15,
    },
  ])

  switch (action) {
    case 'start':
      await handleStartContainer(containerName)
      await showContainerSubmenu(containerName)
      return
    case 'stop':
      await handleStopContainer(containerName)
      await showContainerSubmenu(containerName)
      return
    case 'shell':
      await handleOpenShell(containerName)
      await showContainerSubmenu(containerName)
      return
    case 'edit': {
      const newName = await handleEditContainer(containerName)
      if (newName === null) {
        // User chose to go back to main menu
        return
      }
      if (newName !== containerName) {
        // Container was renamed, show submenu with new name
        await showContainerSubmenu(newName)
      } else {
        await showContainerSubmenu(containerName)
      }
      return
    }
    case 'clone':
      await handleCloneFromSubmenu(containerName)
      return
    case 'copy':
      await handleCopyConnectionString(containerName)
      await showContainerSubmenu(containerName)
      return
    case 'delete':
      await handleDelete(containerName)
      return // Don't show submenu again after delete
    case 'back':
      await handleList()
      return
    case 'main':
      return // Return to main menu
  }
}

async function handleStart(): Promise<void> {
  const containers = await containerManager.list()
  const stopped = containers.filter((c) => c.status !== 'running')

  if (stopped.length === 0) {
    console.log(warning('All containers are already running'))
    return
  }

  const containerName = await promptContainerSelect(
    stopped,
    'Select container to start:',
  )
  if (!containerName) return

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  // Check port availability
  const portAvailable = await portManager.isPortAvailable(config.port)
  if (!portAvailable) {
    const { port: newPort } = await portManager.findAvailablePort()
    console.log(
      warning(`Port ${config.port} is in use, switching to port ${newPort}`),
    )
    config.port = newPort
    await containerManager.updateConfig(containerName, { port: newPort })
  }

  const engine = getEngine(config.engine)

  const spinner = createSpinner(`Starting ${containerName}...`)
  spinner.start()

  await engine.start(config)
  await containerManager.updateConfig(containerName, { status: 'running' })

  spinner.succeed(`Container "${containerName}" started`)

  const connectionString = engine.getConnectionString(config)
  console.log()
  console.log(chalk.gray('  Connection string:'))
  console.log(chalk.cyan(`  ${connectionString}`))
}

async function handleStop(): Promise<void> {
  const containers = await containerManager.list()
  const running = containers.filter((c) => c.status === 'running')

  if (running.length === 0) {
    console.log(warning('No running containers'))
    return
  }

  const containerName = await promptContainerSelect(
    running,
    'Select container to stop:',
  )
  if (!containerName) return

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)

  const spinner = createSpinner(`Stopping ${containerName}...`)
  spinner.start()

  await engine.stop(config)
  await containerManager.updateConfig(containerName, { status: 'stopped' })

  spinner.succeed(`Container "${containerName}" stopped`)
}

async function handleCopyConnectionString(
  containerName: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)
  const connectionString = engine.getConnectionString(config)

  // Copy to clipboard using platform service
  const copied = await platformService.copyToClipboard(connectionString)

  console.log()
  if (copied) {
    console.log(success('Connection string copied to clipboard'))
    console.log(chalk.gray(`  ${connectionString}`))
  } else {
    console.log(warning('Could not copy to clipboard. Connection string:'))
    console.log(chalk.cyan(`  ${connectionString}`))
  }
  console.log()

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to continue...'),
    },
  ])
}

async function handleOpenShell(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)
  const connectionString = engine.getConnectionString(config)

  // Check which enhanced shells are installed
  const usqlInstalled = await isUsqlInstalled()
  const pgcliInstalled = await isPgcliInstalled()
  const mycliInstalled = await isMycliInstalled()

  type ShellChoice =
    | 'default'
    | 'usql'
    | 'install-usql'
    | 'pgcli'
    | 'install-pgcli'
    | 'mycli'
    | 'install-mycli'
    | 'back'

  const defaultShellName = config.engine === 'mysql' ? 'mysql' : 'psql'
  const engineSpecificCli = config.engine === 'mysql' ? 'mycli' : 'pgcli'
  const engineSpecificInstalled =
    config.engine === 'mysql' ? mycliInstalled : pgcliInstalled

  const choices: Array<{ name: string; value: ShellChoice }> = [
    {
      name: `>_ Use default shell (${defaultShellName})`,
      value: 'default',
    },
  ]

  // Engine-specific enhanced CLI (pgcli for PostgreSQL, mycli for MySQL)
  if (engineSpecificInstalled) {
    choices.push({
      name: `⚡ Use ${engineSpecificCli} (enhanced features, recommended)`,
      value: config.engine === 'mysql' ? 'mycli' : 'pgcli',
    })
  } else {
    choices.push({
      name: `↓ Install ${engineSpecificCli} (enhanced features, recommended)`,
      value: config.engine === 'mysql' ? 'install-mycli' : 'install-pgcli',
    })
  }

  // usql - universal option
  if (usqlInstalled) {
    choices.push({
      name: '⚡ Use usql (universal SQL client)',
      value: 'usql',
    })
  } else {
    choices.push({
      name: '↓ Install usql (universal SQL client)',
      value: 'install-usql',
    })
  }

  choices.push({
    name: `${chalk.blue('←')} Back`,
    value: 'back',
  })

  const { shellChoice } = await inquirer.prompt<{ shellChoice: ShellChoice }>([
    {
      type: 'list',
      name: 'shellChoice',
      message: 'Select shell option:',
      choices,
      pageSize: 10,
    },
  ])

  if (shellChoice === 'back') {
    return
  }

  // Handle pgcli installation
  if (shellChoice === 'install-pgcli') {
    console.log()
    console.log(info('Installing pgcli for enhanced PostgreSQL shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installPgcli(pm)
      if (result.success) {
        console.log(success('pgcli installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'pgcli')
      } else {
        console.error(error(`Failed to install pgcli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getPgcliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(error('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getPgcliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  // Handle mycli installation
  if (shellChoice === 'install-mycli') {
    console.log()
    console.log(info('Installing mycli for enhanced MySQL shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installMycli(pm)
      if (result.success) {
        console.log(success('mycli installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'mycli')
      } else {
        console.error(error(`Failed to install mycli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getMycliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(error('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getMycliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  // Handle usql installation
  if (shellChoice === 'install-usql') {
    console.log()
    console.log(info('Installing usql for enhanced shell experience...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installUsql(pm)
      if (result.success) {
        console.log(success('usql installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'usql')
      } else {
        console.error(error(`Failed to install usql: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getUsqlManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(error('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getUsqlManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  // Launch the selected shell
  await launchShell(containerName, config, connectionString, shellChoice)
}

async function launchShell(
  containerName: string,
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>,
  connectionString: string,
  shellType: 'default' | 'usql' | 'pgcli' | 'mycli',
): Promise<void> {
  console.log(info(`Connecting to ${containerName}...`))
  console.log()

  // Determine shell command based on engine and shell type
  let shellCmd: string
  let shellArgs: string[]
  let installHint: string

  if (shellType === 'pgcli') {
    // pgcli accepts connection strings
    shellCmd = 'pgcli'
    shellArgs = [connectionString]
    installHint = 'brew install pgcli'
  } else if (shellType === 'mycli') {
    // mycli: mycli -h host -P port -u user database
    shellCmd = 'mycli'
    shellArgs = [
      '-h',
      '127.0.0.1',
      '-P',
      String(config.port),
      '-u',
      'root',
      config.database,
    ]
    installHint = 'brew install mycli'
  } else if (shellType === 'usql') {
    // usql accepts connection strings directly for both PostgreSQL and MySQL
    shellCmd = 'usql'
    shellArgs = [connectionString]
    installHint = 'brew tap xo/xo && brew install xo/xo/usql'
  } else if (config.engine === 'mysql') {
    shellCmd = 'mysql'
    // MySQL connection: mysql -u root -h 127.0.0.1 -P port database
    shellArgs = [
      '-u',
      'root',
      '-h',
      '127.0.0.1',
      '-P',
      String(config.port),
      config.database,
    ]
    installHint = 'brew install mysql-client'
  } else {
    // PostgreSQL (default)
    shellCmd = 'psql'
    shellArgs = [connectionString]
    installHint = 'brew install libpq && brew link --force libpq'
  }

  const shellProcess = spawn(shellCmd, shellArgs, {
    stdio: 'inherit',
  })

  shellProcess.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      console.log(warning(`${shellCmd} not found on your system.`))
      console.log()
      console.log(chalk.gray('  Connect manually with:'))
      console.log(chalk.cyan(`  ${connectionString}`))
      console.log()
      console.log(chalk.gray(`  Install ${shellCmd}:`))
      console.log(chalk.cyan(`  ${installHint}`))
    }
  })

  await new Promise<void>((resolve) => {
    shellProcess.on('close', () => resolve())
  })
}

/**
 * Create a new container for the restore flow
 * Returns the container name and config if successful, null if cancelled/error
 */
async function handleCreateForRestore(): Promise<{
  name: string
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>
} | null> {
  console.log()
  const answers = await promptCreateOptions()
  let { name: containerName } = answers
  const { engine, version, port, database } = answers

  console.log()
  console.log(header('Creating Database Container'))
  console.log()

  const dbEngine = getEngine(engine)

  // Check if port is currently in use
  const portAvailable = await portManager.isPortAvailable(port)
  if (!portAvailable) {
    console.log(
      error(`Port ${port} is in use. Please choose a different port.`),
    )
    return null
  }

  // Ensure binaries
  const binarySpinner = createSpinner(
    `Checking PostgreSQL ${version} binaries...`,
  )
  binarySpinner.start()

  const isInstalled = await dbEngine.isBinaryInstalled(version)
  if (isInstalled) {
    binarySpinner.succeed(`PostgreSQL ${version} binaries ready (cached)`)
  } else {
    binarySpinner.text = `Downloading PostgreSQL ${version} binaries...`
    await dbEngine.ensureBinaries(version, ({ message }) => {
      binarySpinner.text = message
    })
    binarySpinner.succeed(`PostgreSQL ${version} binaries downloaded`)
  }

  // Check if container name already exists and prompt for new name if needed
  while (await containerManager.exists(containerName)) {
    console.log(chalk.yellow(`  Container "${containerName}" already exists.`))
    containerName = await promptContainerName()
  }

  // Create container
  const createSpinnerInstance = createSpinner('Creating container...')
  createSpinnerInstance.start()

  await containerManager.create(containerName, {
    engine: dbEngine.name as Engine,
    version,
    port,
    database,
  })

  createSpinnerInstance.succeed('Container created')

  // Initialize database cluster
  const initSpinner = createSpinner('Initializing database cluster...')
  initSpinner.start()

  await dbEngine.initDataDir(containerName, version, {
    superuser: defaults.superuser,
  })

  initSpinner.succeed('Database cluster initialized')

  // Start container
  const startSpinner = createSpinner('Starting PostgreSQL...')
  startSpinner.start()

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    startSpinner.fail('Failed to get container config')
    return null
  }

  await dbEngine.start(config)
  await containerManager.updateConfig(containerName, { status: 'running' })

  startSpinner.succeed('PostgreSQL started')

  // Create the user's database (if different from 'postgres')
  if (database !== 'postgres') {
    const dbSpinner = createSpinner(`Creating database "${database}"...`)
    dbSpinner.start()

    await dbEngine.createDatabase(config, database)

    dbSpinner.succeed(`Database "${database}" created`)
  }

  console.log()
  console.log(success('Container ready for restore'))
  console.log()

  return { name: containerName, config }
}

async function handleRestore(): Promise<void> {
  const containers = await containerManager.list()
  const running = containers.filter((c) => c.status === 'running')

  // Build choices: running containers + create new option
  const choices = [
    ...running.map((c) => ({
      name: `${c.name} ${chalk.gray(`(${engineIcons[c.engine] || '▣'} ${c.engine} ${c.version}, port ${c.port})`)} ${chalk.green('● running')}`,
      value: c.name,
      short: c.name,
    })),
    new inquirer.Separator(),
    {
      name: `${chalk.green('➕')} Create new container`,
      value: '__create_new__',
      short: 'Create new',
    },
  ]

  const { selectedContainer } = await inquirer.prompt<{
    selectedContainer: string
  }>([
    {
      type: 'list',
      name: 'selectedContainer',
      message: 'Select container to restore to:',
      choices,
      pageSize: 15,
    },
  ])

  let containerName: string
  let config: Awaited<ReturnType<typeof containerManager.getConfig>>

  if (selectedContainer === '__create_new__') {
    // Run the create flow first
    const createResult = await handleCreateForRestore()
    if (!createResult) return // User cancelled or error
    containerName = createResult.name
    config = createResult.config
  } else {
    containerName = selectedContainer
    config = await containerManager.getConfig(containerName)
    if (!config) {
      console.error(error(`Container "${containerName}" not found`))
      return
    }
  }

  // Check for required client tools BEFORE doing anything
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
      return
    }

    // Verify installation worked
    missingDeps = await getMissingDependencies(config.engine)
    if (missingDeps.length > 0) {
      console.log(
        error(
          `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
        ),
      )
      return
    }

    console.log(chalk.green('  ✓ All required tools are now available'))
    console.log()
  } else {
    depsSpinner.succeed('Required tools available')
  }

  // Ask for restore source
  const { restoreSource } = await inquirer.prompt<{
    restoreSource: 'file' | 'connection'
  }>([
    {
      type: 'list',
      name: 'restoreSource',
      message: 'Restore from:',
      choices: [
        {
          name: `${chalk.magenta('📁')} Dump file (drag and drop or enter path)`,
          value: 'file',
        },
        {
          name: `${chalk.cyan('🔗')} Connection string (pull from remote database)`,
          value: 'connection',
        },
      ],
    },
  ])

  let backupPath = ''
  let isTempFile = false

  if (restoreSource === 'connection') {
    // Get connection string and create dump
    const { connectionString } = await inquirer.prompt<{
      connectionString: string
    }>([
      {
        type: 'input',
        name: 'connectionString',
        message: 'Connection string (postgresql://user:pass@host:port/dbname):',
        validate: (input: string) => {
          if (!input) return 'Connection string is required'
          if (
            !input.startsWith('postgresql://') &&
            !input.startsWith('postgres://')
          ) {
            return 'Connection string must start with postgresql:// or postgres://'
          }
          return true
        },
      },
    ])

    const engine = getEngine(config.engine)

    // Create temp file for the dump
    const timestamp = Date.now()
    const tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}.dump`)

    let dumpSuccess = false
    let attempts = 0
    const maxAttempts = 2 // Allow one retry after installing deps

    while (!dumpSuccess && attempts < maxAttempts) {
      attempts++
      const dumpSpinner = createSpinner('Creating dump from remote database...')
      dumpSpinner.start()

      try {
        await engine.dumpFromConnectionString(connectionString, tempDumpPath)
        dumpSpinner.succeed('Dump created from remote database')
        backupPath = tempDumpPath
        isTempFile = true
        dumpSuccess = true
      } catch (err) {
        const e = err as Error
        dumpSpinner.fail('Failed to create dump')

        // Check if this is a missing tool error
        if (
          e.message.includes('pg_dump not found') ||
          e.message.includes('ENOENT')
        ) {
          const installed = await promptInstallDependencies('pg_dump')
          if (installed) {
            // Loop will retry
            continue
          }
        } else {
          console.log()
          console.log(error('pg_dump error:'))
          console.log(chalk.gray(`  ${e.message}`))
          console.log()
        }

        // Clean up temp file if it was created
        try {
          await rm(tempDumpPath, { force: true })
        } catch {
          // Ignore cleanup errors
        }

        // Wait for user to see the error
        await inquirer.prompt([
          {
            type: 'input',
            name: 'continue',
            message: chalk.gray('Press Enter to continue...'),
          },
        ])
        return
      }
    }

    // Safety check - should never reach here without backupPath set
    if (!dumpSuccess) {
      console.log(error('Failed to create dump after retries'))
      return
    }
  } else {
    // Get backup file path
    // Strip quotes that terminals add when drag-and-dropping files
    const stripQuotes = (path: string) =>
      path.replace(/^['"]|['"]$/g, '').trim()

    const { backupPath: rawBackupPath } = await inquirer.prompt<{
      backupPath: string
    }>([
      {
        type: 'input',
        name: 'backupPath',
        message: 'Path to backup file (drag and drop or enter path):',
        validate: (input: string) => {
          if (!input) return 'Backup path is required'
          const cleanPath = stripQuotes(input)
          if (!existsSync(cleanPath)) return 'File not found'
          return true
        },
      },
    ])
    backupPath = stripQuotes(rawBackupPath)
  }

  const databaseName = await promptDatabaseName(containerName, config.engine)

  const engine = getEngine(config.engine)

  // Detect format
  const detectSpinner = createSpinner('Detecting backup format...')
  detectSpinner.start()

  const format = await engine.detectBackupFormat(backupPath)
  detectSpinner.succeed(`Detected: ${format.description}`)

  // Create database
  const dbSpinner = createSpinner(`Creating database "${databaseName}"...`)
  dbSpinner.start()

  await engine.createDatabase(config, databaseName)
  dbSpinner.succeed(`Database "${databaseName}" ready`)

  // Restore
  const restoreSpinner = createSpinner('Restoring backup...')
  restoreSpinner.start()

  const result = await engine.restore(config, backupPath, {
    database: databaseName,
    createDatabase: false,
  })

  if (result.code === 0 || !result.stderr) {
    restoreSpinner.succeed('Backup restored successfully')
  } else {
    const stderr = result.stderr || ''

    // Check for version compatibility errors
    if (
      stderr.includes('unsupported version') ||
      stderr.includes('Archive version') ||
      stderr.includes('too old')
    ) {
      restoreSpinner.fail('Version compatibility detected')
      console.log()
      console.log(error('PostgreSQL version incompatibility detected:'))
      console.log(
        warning('Your pg_restore version is too old for this backup file.'),
      )

      // Clean up the failed database since restore didn't actually work
      console.log(chalk.yellow('Cleaning up failed database...'))
      try {
        await engine.dropDatabase(config, databaseName)
        console.log(chalk.gray(`✓ Removed database "${databaseName}"`))
      } catch {
        console.log(
          chalk.yellow(`Warning: Could not remove database "${databaseName}"`),
        )
      }

      console.log()

      // Extract version info from error message
      const versionMatch = stderr.match(/PostgreSQL (\d+)/)
      const requiredVersion = versionMatch ? versionMatch[1] : '17'

      console.log(
        chalk.gray(
          `This backup was created with PostgreSQL ${requiredVersion}`,
        ),
      )
      console.log()

      // Ask user if they want to upgrade
      const { shouldUpgrade } = await inquirer.prompt({
        type: 'list',
        name: 'shouldUpgrade',
        message: `Would you like to upgrade PostgreSQL client tools to support PostgreSQL ${requiredVersion}?`,
        choices: [
          { name: 'Yes', value: true },
          { name: 'No', value: false },
        ],
        default: 0,
      })

      if (shouldUpgrade) {
        console.log()
        const upgradeSpinner = createSpinner(
          'Upgrading PostgreSQL client tools...',
        )
        upgradeSpinner.start()

        try {
          const { updatePostgresClientTools } = await import(
            '../../engines/postgresql/binary-manager'
          )
          const updateSuccess = await updatePostgresClientTools()

          if (updateSuccess) {
            upgradeSpinner.succeed('PostgreSQL client tools upgraded')
            console.log()
            console.log(
              success('Please try the restore again with the updated tools.'),
            )
            await new Promise((resolve) => {
              console.log(chalk.gray('Press Enter to continue...'))
              process.stdin.once('data', resolve)
            })
            return
          } else {
            upgradeSpinner.fail('Upgrade failed')
            console.log()
            console.log(
              error('Automatic upgrade failed. Please upgrade manually:'),
            )
            const pgPackage = getPostgresHomebrewPackage()
            const latestMajor = pgPackage.split('@')[1]
            console.log(
              warning(
                `  macOS: brew install ${pgPackage} && brew link --force ${pgPackage}`,
              ),
            )
            console.log(
              chalk.gray(
                `    This installs PostgreSQL ${latestMajor} client tools: pg_restore, pg_dump, psql, and libpq`,
              ),
            )
            console.log(
              warning(
                `  Ubuntu/Debian: sudo apt update && sudo apt install postgresql-client-${latestMajor}`,
              ),
            )
            console.log(
              chalk.gray(
                `    This installs PostgreSQL ${latestMajor} client tools: pg_restore, pg_dump, psql, and libpq`,
              ),
            )
            await new Promise((resolve) => {
              console.log(chalk.gray('Press Enter to continue...'))
              process.stdin.once('data', resolve)
            })
            return
          }
        } catch {
          upgradeSpinner.fail('Upgrade failed')
          console.log(error('Failed to upgrade PostgreSQL client tools'))
          console.log(
            chalk.gray(
              'Manual upgrade may be required for pg_restore, pg_dump, and psql',
            ),
          )
          await new Promise((resolve) => {
            console.log(chalk.gray('Press Enter to continue...'))
            process.stdin.once('data', resolve)
          })
          return
        }
      } else {
        console.log()
        console.log(
          warning(
            'Restore cancelled. Please upgrade PostgreSQL client tools manually and try again.',
          ),
        )
        await new Promise((resolve) => {
          console.log(chalk.gray('Press Enter to continue...'))
          process.stdin.once('data', resolve)
        })
        return
      }
    } else {
      // Regular warnings/errors - show as before
      restoreSpinner.warn('Restore completed with warnings')
      // Show stderr output so user can see what went wrong
      if (result.stderr) {
        console.log()
        console.log(chalk.yellow('  Warnings/Errors:'))
        // Show first 20 lines of stderr to avoid overwhelming output
        const lines = result.stderr.split('\n').filter((l) => l.trim())
        const displayLines = lines.slice(0, 20)
        for (const line of displayLines) {
          console.log(chalk.gray(`  ${line}`))
        }
        if (lines.length > 20) {
          console.log(chalk.gray(`  ... and ${lines.length - 20} more lines`))
        }
      }
    }
  }

  // Only show success message if restore actually succeeded
  if (result.code === 0 || !result.stderr) {
    const connectionString = engine.getConnectionString(config, databaseName)
    console.log()
    console.log(success(`Database "${databaseName}" restored`))
    console.log(chalk.gray('  Connection string:'))
    console.log(chalk.cyan(`  ${connectionString}`))

    // Copy connection string to clipboard using platform service
    const copied = await platformService.copyToClipboard(connectionString)
    if (copied) {
      console.log(chalk.gray('  ✓ Connection string copied to clipboard'))
    } else {
      console.log(chalk.gray('  (Could not copy to clipboard)'))
    }

    console.log()
  }

  // Clean up temp file if we created one
  if (isTempFile) {
    try {
      await rm(backupPath, { force: true })
    } catch {
      // Ignore cleanup errors
    }
  }

  // Wait for user to see the result before returning to menu
  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to continue...'),
    },
  ])
}

/**
 * Generate a timestamp string for backup filenames
 */
function generateBackupTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/:/g, '').split('.')[0]
}

/**
 * Get file extension for backup format
 */
function getBackupExtension(format: 'sql' | 'dump', engine: string): string {
  if (format === 'sql') {
    return '.sql'
  }
  return engine === 'mysql' ? '.sql.gz' : '.dump'
}

async function handleBackup(): Promise<void> {
  const containers = await containerManager.list()
  const running = containers.filter((c) => c.status === 'running')

  if (running.length === 0) {
    console.log(warning('No running containers. Start a container first.'))
    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('Press Enter to continue...'),
      },
    ])
    return
  }

  // Select container
  const containerName = await promptContainerSelect(
    running,
    'Select container to backup:',
  )
  if (!containerName) return

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(error(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)

  // Check for required tools
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
      return
    }

    missingDeps = await getMissingDependencies(config.engine)
    if (missingDeps.length > 0) {
      console.log(
        error(
          `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
        ),
      )
      return
    }

    console.log(chalk.green('  ✓ All required tools are now available'))
    console.log()
  } else {
    depsSpinner.succeed('Required tools available')
  }

  // Select database
  const databases = config.databases || [config.database]
  let databaseName: string

  if (databases.length > 1) {
    databaseName = await promptDatabaseSelect(
      databases,
      'Select database to backup:',
    )
  } else {
    databaseName = databases[0]
  }

  // Select format
  const format = await promptBackupFormat(config.engine)

  // Get filename
  const defaultFilename = `${containerName}-${databaseName}-backup-${generateBackupTimestamp()}`
  const filename = await promptBackupFilename(defaultFilename)

  // Build output path
  const extension = getBackupExtension(format, config.engine)
  const outputPath = join(process.cwd(), `${filename}${extension}`)

  // Create backup
  const backupSpinner = createSpinner(
    `Creating ${format === 'sql' ? 'SQL' : 'dump'} backup of "${databaseName}"...`,
  )
  backupSpinner.start()

  try {
    const result = await engine.backup(config, outputPath, {
      database: databaseName,
      format,
    })

    backupSpinner.succeed('Backup created successfully')

    console.log()
    console.log(success('Backup complete'))
    console.log()
    console.log(chalk.gray('  File:'), chalk.cyan(result.path))
    console.log(chalk.gray('  Size:'), chalk.white(formatBytes(result.size)))
    console.log(chalk.gray('  Format:'), chalk.white(result.format))
    console.log()
  } catch (err) {
    const e = err as Error
    backupSpinner.fail('Backup failed')
    console.log()
    console.log(error(e.message))
    console.log()
  }

  // Wait for user to see the result
  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to continue...'),
    },
  ])
}

async function handleClone(): Promise<void> {
  const containers = await containerManager.list()
  const stopped = containers.filter((c) => c.status !== 'running')

  if (containers.length === 0) {
    console.log(warning('No containers found'))
    return
  }

  if (stopped.length === 0) {
    console.log(
      warning(
        'All containers are running. Stop a container first to clone it.',
      ),
    )
    return
  }

  const sourceName = await promptContainerSelect(
    stopped,
    'Select container to clone:',
  )
  if (!sourceName) return

  const { targetName } = await inquirer.prompt<{ targetName: string }>([
    {
      type: 'input',
      name: 'targetName',
      message: 'Name for the cloned container:',
      default: `${sourceName}-copy`,
      validate: (input: string) => {
        if (!input) return 'Name is required'
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
          return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores'
        }
        return true
      },
    },
  ])

  const spinner = createSpinner(`Cloning ${sourceName} to ${targetName}...`)
  spinner.start()

  const newConfig = await containerManager.clone(sourceName, targetName)

  spinner.succeed(`Cloned "${sourceName}" to "${targetName}"`)

  const engine = getEngine(newConfig.engine)
  const connectionString = engine.getConnectionString(newConfig)

  console.log()
  console.log(connectionBox(targetName, connectionString, newConfig.port))
}

async function handleStartContainer(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  // Check port availability
  const portAvailable = await portManager.isPortAvailable(config.port)
  if (!portAvailable) {
    console.log(
      warning(
        `Port ${config.port} is in use. Stop the process using it or change this container's port.`,
      ),
    )
    console.log()
    console.log(
      info(
        'Tip: If you installed MariaDB via apt, it may have started a system service.',
      ),
    )
    console.log(
      info(
        'Run: sudo systemctl stop mariadb && sudo systemctl disable mariadb',
      ),
    )
    return
  }

  const engine = getEngine(config.engine)

  const spinner = createSpinner(`Starting ${containerName}...`)
  spinner.start()

  try {
    await engine.start(config)
    await containerManager.updateConfig(containerName, { status: 'running' })

    spinner.succeed(`Container "${containerName}" started`)

    const connectionString = engine.getConnectionString(config)
    console.log()
    console.log(chalk.gray('  Connection string:'))
    console.log(chalk.cyan(`  ${connectionString}`))
  } catch (err) {
    spinner.fail(`Failed to start "${containerName}"`)
    const e = err as Error
    console.log()
    console.log(error(e.message))

    // Check if there's a log file with more details
    const logPath = paths.getContainerLogPath(containerName, {
      engine: config.engine,
    })
    if (existsSync(logPath)) {
      console.log()
      console.log(info(`Check the log file for details: ${logPath}`))
    }
  }
}

async function handleStopContainer(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)

  const spinner = createSpinner(`Stopping ${containerName}...`)
  spinner.start()

  await engine.stop(config)
  await containerManager.updateConfig(containerName, { status: 'stopped' })

  spinner.succeed(`Container "${containerName}" stopped`)
}

async function handleEditContainer(
  containerName: string,
): Promise<string | null> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return null
  }

  console.clear()
  console.log(header(`Edit: ${containerName}`))
  console.log()

  const editChoices = [
    {
      name: `Name: ${chalk.white(containerName)}`,
      value: 'name',
    },
    {
      name: `Port: ${chalk.white(String(config.port))}`,
      value: 'port',
    },
    new inquirer.Separator(),
    { name: `${chalk.blue('←')} Back to container`, value: 'back' },
    { name: `${chalk.blue('⌂')} Back to main menu`, value: 'main' },
  ]

  const { field } = await inquirer.prompt<{ field: string }>([
    {
      type: 'list',
      name: 'field',
      message: 'Select field to edit:',
      choices: editChoices,
      pageSize: 10,
    },
  ])

  if (field === 'back') {
    return containerName
  }

  if (field === 'main') {
    return null // Signal to go back to main menu
  }

  if (field === 'name') {
    const { newName } = await inquirer.prompt<{ newName: string }>([
      {
        type: 'input',
        name: 'newName',
        message: 'New name:',
        default: containerName,
        validate: (input: string) => {
          if (!input) return 'Name is required'
          if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
            return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores'
          }
          return true
        },
      },
    ])

    if (newName === containerName) {
      console.log(info('Name unchanged'))
      return await handleEditContainer(containerName)
    }

    // Check if new name already exists
    if (await containerManager.exists(newName)) {
      console.log(error(`Container "${newName}" already exists`))
      return await handleEditContainer(containerName)
    }

    const spinner = createSpinner('Renaming container...')
    spinner.start()

    await containerManager.rename(containerName, newName)

    spinner.succeed(`Renamed "${containerName}" to "${newName}"`)

    // Continue editing with new name
    return await handleEditContainer(newName)
  }

  if (field === 'port') {
    const { newPort } = await inquirer.prompt<{ newPort: number }>([
      {
        type: 'input',
        name: 'newPort',
        message: 'New port:',
        default: String(config.port),
        validate: (input: string) => {
          const num = parseInt(input, 10)
          if (isNaN(num) || num < 1 || num > 65535) {
            return 'Port must be a number between 1 and 65535'
          }
          return true
        },
        filter: (input: string) => parseInt(input, 10),
      },
    ])

    if (newPort === config.port) {
      console.log(info('Port unchanged'))
      return await handleEditContainer(containerName)
    }

    // Check if port is in use
    const portAvailable = await portManager.isPortAvailable(newPort)
    if (!portAvailable) {
      console.log(
        warning(
          `Port ${newPort} is currently in use. You'll need to stop the process using it before starting this container.`,
        ),
      )
    }

    await containerManager.updateConfig(containerName, { port: newPort })
    console.log(success(`Changed port from ${config.port} to ${newPort}`))

    // Continue editing
    return await handleEditContainer(containerName)
  }

  return containerName
}

async function handleCloneFromSubmenu(sourceName: string): Promise<void> {
  const { targetName } = await inquirer.prompt<{ targetName: string }>([
    {
      type: 'input',
      name: 'targetName',
      message: 'Name for the cloned container:',
      default: `${sourceName}-copy`,
      validate: (input: string) => {
        if (!input) return 'Name is required'
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
          return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores'
        }
        return true
      },
    },
  ])

  const spinner = createSpinner(`Cloning ${sourceName} to ${targetName}...`)
  spinner.start()

  const newConfig = await containerManager.clone(sourceName, targetName)

  spinner.succeed(`Cloned "${sourceName}" to "${targetName}"`)

  const engine = getEngine(newConfig.engine)
  const connectionString = engine.getConnectionString(newConfig)

  console.log()
  console.log(connectionBox(targetName, connectionString, newConfig.port))

  // Go to the new container's submenu
  await showContainerSubmenu(targetName)
}

async function handleDelete(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  const confirmed = await promptConfirm(
    `Are you sure you want to delete "${containerName}"? This cannot be undone.`,
    false,
  )

  if (!confirmed) {
    console.log(warning('Deletion cancelled'))
    return
  }

  const isRunning = await processManager.isRunning(containerName, {
    engine: config.engine,
  })

  if (isRunning) {
    const stopSpinner = createSpinner(`Stopping ${containerName}...`)
    stopSpinner.start()

    const engine = getEngine(config.engine)
    await engine.stop(config)

    stopSpinner.succeed(`Stopped "${containerName}"`)
  }

  const deleteSpinner = createSpinner(`Deleting ${containerName}...`)
  deleteSpinner.start()

  await containerManager.delete(containerName, { force: true })

  deleteSpinner.succeed(`Container "${containerName}" deleted`)
}

type InstalledPostgresEngine = {
  engine: 'postgresql'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

type InstalledMysqlEngine = {
  engine: 'mysql'
  version: string
  path: string
  source: 'system'
  isMariaDB: boolean
}

type InstalledEngine = InstalledPostgresEngine | InstalledMysqlEngine

const execAsync = promisify(exec)

/**
 * Get the actual PostgreSQL version from the binary
 */
async function getPostgresVersionFromBinary(
  binPath: string,
): Promise<string | null> {
  const postgresPath = join(binPath, 'bin', 'postgres')
  if (!existsSync(postgresPath)) {
    return null
  }

  try {
    const { stdout } = await execAsync(`"${postgresPath}" --version`)
    // Output: postgres (PostgreSQL) 17.7
    const match = stdout.match(/\(PostgreSQL\)\s+([\d.]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

async function getInstalledEngines(): Promise<InstalledEngine[]> {
  const engines: InstalledEngine[] = []

  // Get PostgreSQL engines from ~/.spindb/bin/
  const binDir = paths.bin
  if (existsSync(binDir)) {
    const entries = await readdir(binDir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Parse directory name: postgresql-17-darwin-arm64
        const match = entry.name.match(/^(\w+)-(.+)-(\w+)-(\w+)$/)
        if (match && match[1] === 'postgresql') {
          const [, , majorVersion, platform, arch] = match
          const dirPath = join(binDir, entry.name)

          // Get actual version from the binary
          const actualVersion =
            (await getPostgresVersionFromBinary(dirPath)) || majorVersion

          // Get directory size (using lstat to avoid following symlinks)
          let sizeBytes = 0
          try {
            const files = await readdir(dirPath, { recursive: true })
            for (const file of files) {
              try {
                const filePath = join(dirPath, file.toString())
                const fileStat = await lstat(filePath)
                // Only count regular files (not symlinks or directories)
                if (fileStat.isFile()) {
                  sizeBytes += fileStat.size
                }
              } catch {
                // Skip files we can't stat
              }
            }
          } catch {
            // Skip directories we can't read
          }

          engines.push({
            engine: 'postgresql',
            version: actualVersion,
            platform,
            arch,
            path: dirPath,
            sizeBytes,
            source: 'downloaded',
          })
        }
      }
    }
  }

  // Detect system-installed MySQL
  const mysqldPath = await getMysqldPath()
  if (mysqldPath) {
    const version = await getMysqlVersion(mysqldPath)
    if (version) {
      const mariadb = await isMariaDB()
      engines.push({
        engine: 'mysql',
        version,
        path: mysqldPath,
        source: 'system',
        isMariaDB: mariadb,
      })
    }
  }

  // Sort PostgreSQL by version (descending), MySQL stays at end
  const pgEngines = engines.filter(
    (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
  )
  const mysqlEngine = engines.find(
    (e): e is InstalledMysqlEngine => e.engine === 'mysql',
  )

  pgEngines.sort((a, b) => compareVersions(b.version, a.version))

  const result: InstalledEngine[] = [...pgEngines]
  if (mysqlEngine) {
    result.push(mysqlEngine)
  }

  return result
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((p) => parseInt(p, 10) || 0)
  const partsB = b.split('.').map((p) => parseInt(p, 10) || 0)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA !== numB) return numA - numB
  }
  return 0
}

async function handleEngines(): Promise<void> {
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
    const icon = engineIcons[engine.engine] || '▣'
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
    const icon = engineIcons.mysql
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

export const menuCommand = new Command('menu')
  .description('Interactive menu for managing containers')
  .action(async () => {
    try {
      await showMainMenu()
    } catch (err) {
      const e = err as Error

      // Check if this is a missing tool error
      if (
        e.message.includes('pg_restore not found') ||
        e.message.includes('psql not found') ||
        e.message.includes('pg_dump not found')
      ) {
        const missingTool = e.message.includes('pg_restore')
          ? 'pg_restore'
          : e.message.includes('pg_dump')
            ? 'pg_dump'
            : 'psql'
        const installed = await promptInstallDependencies(missingTool)
        if (installed) {
          console.log(chalk.yellow('  Please re-run spindb to continue.'))
        }
        process.exit(1)
      }

      console.error(error(e.message))
      process.exit(1)
    }
  })
