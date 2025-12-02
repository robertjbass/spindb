import chalk from 'chalk'
import inquirer from 'inquirer'
import { existsSync } from 'fs'
import { containerManager } from '../../../core/container-manager'
import { getMissingDependencies } from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { portManager } from '../../../core/port-manager'
import { processManager } from '../../../core/process-manager'
import { getEngine } from '../../../engines'
import { defaults } from '../../../config/defaults'
import { paths } from '../../../config/paths'
import {
  promptCreateOptions,
  promptContainerName,
  promptContainerSelect,
  promptInstallDependencies,
  promptConfirm,
} from '../../ui/prompts'
import { createSpinner } from '../../ui/spinner'
import {
  header,
  success,
  error,
  warning,
  info,
  connectionBox,
  formatBytes,
} from '../../ui/theme'
import { getEngineIcon } from '../../constants'
import { handleOpenShell, handleCopyConnectionString } from './shell-handlers'
import { handleRunSql, handleViewLogs } from './sql-handlers'
import { type Engine } from '../../../types'
import { type MenuChoice } from './shared'

export async function handleCreate(): Promise<void> {
  console.log()
  const answers = await promptCreateOptions()
  let { name: containerName } = answers
  const { engine, version, port, database } = answers

  console.log()
  console.log(header('Creating Database Container'))
  console.log()

  const dbEngine = getEngine(engine)

  const depsSpinner = createSpinner('Checking required tools...')
  depsSpinner.start()

  let missingDeps = await getMissingDependencies(engine)
  if (missingDeps.length > 0) {
    depsSpinner.warn(
      `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
    )

    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      engine,
    )

    if (!installed) {
      return
    }

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

  const portAvailable = await portManager.isPortAvailable(port)

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

  while (await containerManager.exists(containerName)) {
    console.log(chalk.yellow(`  Container "${containerName}" already exists.`))
    containerName = await promptContainerName()
  }

  const createSpinnerInstance = createSpinner('Creating container...')
  createSpinnerInstance.start()

  await containerManager.create(containerName, {
    engine: dbEngine.name as Engine,
    version,
    port,
    database,
  })

  createSpinnerInstance.succeed('Container created')

  const initSpinner = createSpinner('Initializing database cluster...')
  initSpinner.start()

  await dbEngine.initDataDir(containerName, version, {
    superuser: defaults.superuser,
  })

  initSpinner.succeed('Database cluster initialized')

  if (portAvailable) {
    const startSpinner = createSpinner('Starting PostgreSQL...')
    startSpinner.start()

    const config = await containerManager.getConfig(containerName)
    if (config) {
      await dbEngine.start(config)
      await containerManager.updateConfig(containerName, { status: 'running' })
    }

    startSpinner.succeed('PostgreSQL started')

    if (config && database !== 'postgres') {
      const dbSpinner = createSpinner(`Creating database "${database}"...`)
      dbSpinner.start()

      await dbEngine.createDatabase(config, database)

      dbSpinner.succeed(`Database "${database}" created`)
    }

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

export async function handleList(
  showMainMenu: () => Promise<void>,
): Promise<void> {
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

  console.log()
  const containerChoices = [
    ...containers.map((c, i) => {
      const size = sizes[i]
      const sizeLabel = size !== null ? `, ${formatBytes(size)}` : ''
      return {
        name: `${c.name} ${chalk.gray(`(${getEngineIcon(c.engine)} ${c.engine} ${c.version}, port ${c.port}${sizeLabel})`)} ${
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

  await showContainerSubmenu(selectedContainer, showMainMenu)
}

export async function showContainerSubmenu(
  containerName: string,
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

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
    !isRunning
      ? {
          name: `${chalk.green('▶')} Start container`,
          value: 'start',
        }
      : {
          name: `${chalk.red('■')} Stop container`,
          value: 'stop',
        },
    {
      name: isRunning
        ? `${chalk.blue('⌘')} Open shell`
        : chalk.gray('⌘ Open shell'),
      value: 'shell',
      disabled: isRunning ? false : 'Start container first',
    },
    {
      name: isRunning
        ? `${chalk.yellow('▷')} Run SQL file`
        : chalk.gray('▷ Run SQL file'),
      value: 'run-sql',
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
      name: `${chalk.gray('☰')} View logs`,
      value: 'logs',
    },
    {
      name: !isRunning
        ? `${chalk.red('✕')} Delete container`
        : chalk.gray('✕ Delete container'),
      value: 'delete',
      disabled: !isRunning ? false : 'Stop container first',
    },
    new inquirer.Separator(),
    {
      name: `${chalk.blue('←')} Back to containers`,
      value: 'back',
    },
    {
      name: `${chalk.blue('⌂')} Back to main menu`,
      value: 'main',
    },
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
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'stop':
      await handleStopContainer(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'shell':
      await handleOpenShell(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'run-sql':
      await handleRunSql(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'logs':
      await handleViewLogs(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'edit': {
      const newName = await handleEditContainer(containerName)
      if (newName === null) {
        // User chose to go back to main menu
        return
      }
      if (newName !== containerName) {
        // Container was renamed, show submenu with new name
        await showContainerSubmenu(newName, showMainMenu)
      } else {
        await showContainerSubmenu(containerName, showMainMenu)
      }
      return
    }
    case 'clone':
      await handleCloneFromSubmenu(containerName, showMainMenu)
      return
    case 'copy':
      await handleCopyConnectionString(containerName)
      await showContainerSubmenu(containerName, showMainMenu)
      return
    case 'delete':
      await handleDelete(containerName)
      return // Don't show submenu again after delete
    case 'back':
      await handleList(showMainMenu)
      return
    case 'main':
      return // Return to main menu
  }
}

export async function handleStart(): Promise<void> {
  const containers = await containerManager.list()
  const stopped = containers.filter((c) => c.status !== 'running')

  if (stopped.length === 0) {
    console.log(warning('All containers are already running'))
    return
  }

  const containerName = await promptContainerSelect(
    stopped,
    'Select container to start:',
    { includeBack: true },
  )
  if (!containerName) return

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

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

export async function handleStop(): Promise<void> {
  const containers = await containerManager.list()
  const running = containers.filter((c) => c.status === 'running')

  if (running.length === 0) {
    console.log(warning('No running containers'))
    return
  }

  const containerName = await promptContainerSelect(
    running,
    'Select container to stop:',
    { includeBack: true },
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

async function handleStartContainer(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

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
    {
      name: `${chalk.blue('←')} Back to container`,
      value: 'back',
    },
    {
      name: `${chalk.blue('⌂')} Back to main menu`,
      value: 'main',
    },
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

async function handleCloneFromSubmenu(
  sourceName: string,
  showMainMenu: () => Promise<void>,
): Promise<void> {
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

  await showContainerSubmenu(targetName, showMainMenu)
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
