import { Command } from 'commander'
import inquirer from 'inquirer'
import chalk from 'chalk'
import { containerManager } from '@/core/container-manager'
import { processManager } from '@/core/process-manager'
import { getEngine } from '@/engines'
import { portManager } from '@/core/port-manager'
import { defaults } from '@/config/defaults'
import {
  promptCreateOptions,
  promptContainerSelect,
  promptConfirm,
  promptDatabaseName,
} from '@/cli/ui/prompts'
import { createSpinner } from '@/cli/ui/spinner'
import {
  header,
  success,
  error,
  warning,
  info,
  connectionBox,
} from '@/cli/ui/theme'
import { existsSync } from 'fs'
import { spawn } from 'child_process'

interface MenuChoice {
  name: string
  value: string
  disabled?: boolean | string
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

  const choices: MenuChoice[] = [
    { name: `${chalk.green('+')} Create new container`, value: 'create' },
    { name: `${chalk.cyan('◉')} List containers`, value: 'list' },
    {
      name: `${chalk.green('▶')} Start a container`,
      value: 'start',
      disabled: stopped === 0 ? 'No stopped containers' : false,
    },
    {
      name: `${chalk.yellow('■')} Stop a container`,
      value: 'stop',
      disabled: running === 0 ? 'No running containers' : false,
    },
    {
      name: `${chalk.blue('⌘')} Open psql shell`,
      value: 'connect',
      disabled: running === 0 ? 'No running containers' : false,
    },
    {
      name: `${chalk.magenta('↓')} Restore backup`,
      value: 'restore',
      disabled: running === 0 ? 'No running containers' : false,
    },
    {
      name: `${chalk.cyan('⧉')} Clone a container`,
      value: 'clone',
      disabled: containers.length === 0 ? 'No containers' : false,
    },
    {
      name: `${chalk.white('⚙')} Change port`,
      value: 'port',
      disabled: stopped === 0 ? 'No stopped containers' : false,
    },
    {
      name: `${chalk.red('✕')} Delete a container`,
      value: 'delete',
      disabled: containers.length === 0 ? 'No containers' : false,
    },
    new inquirer.Separator(),
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
    case 'connect':
      await handleConnect()
      break
    case 'restore':
      await handleRestore()
      break
    case 'clone':
      await handleClone()
      break
    case 'port':
      await handleChangePort()
      break
    case 'delete':
      await handleDelete()
      break
    case 'exit':
      console.log(chalk.gray('\n  Goodbye!\n'))
      process.exit(0)
  }

  // Return to menu after action
  await promptReturnToMenu()
}

async function promptReturnToMenu(): Promise<void> {
  console.log()
  const { returnToMenu } = await inquirer.prompt<{ returnToMenu: string }>([
    {
      type: 'list',
      name: 'returnToMenu',
      message: 'Return to main menu?',
      choices: [
        { name: 'Yes', value: 'yes' },
        { name: 'No', value: 'no' },
      ],
      default: 'yes',
    },
  ])

  if (returnToMenu === 'yes') {
    await showMainMenu()
  } else {
    console.log(chalk.gray('\n  Goodbye!\n'))
    process.exit(0)
  }
}

async function handleCreate(): Promise<void> {
  console.log()
  const answers = await promptCreateOptions()
  const { name: containerName, engine, version } = answers

  console.log()
  console.log(header('Creating Database Container'))
  console.log()

  const dbEngine = getEngine(engine)

  // Find available port
  const portSpinner = createSpinner('Finding available port...')
  portSpinner.start()

  const { port, isDefault } = await portManager.findAvailablePort()
  if (isDefault) {
    portSpinner.succeed(`Using default port ${port}`)
  } else {
    portSpinner.warn(`Default port 5432 is in use, using port ${port}`)
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

  // Create container
  const createSpinnerInstance = createSpinner('Creating container...')
  createSpinnerInstance.start()

  await containerManager.create(containerName, {
    engine: dbEngine.name,
    version,
    port,
  })

  createSpinnerInstance.succeed('Container created')

  // Initialize database
  const initSpinner = createSpinner('Initializing database...')
  initSpinner.start()

  await dbEngine.initDataDir(containerName, version, {
    superuser: defaults.superuser,
  })

  initSpinner.succeed('Database initialized')

  // Start container
  const startSpinner = createSpinner('Starting PostgreSQL...')
  startSpinner.start()

  const config = await containerManager.getConfig(containerName)
  if (config) {
    await dbEngine.start(config)
    await containerManager.updateConfig(containerName, { status: 'running' })
  }

  startSpinner.succeed('PostgreSQL started')

  // Show success
  if (config) {
    const connectionString = dbEngine.getConnectionString(config)
    console.log()
    console.log(connectionBox(containerName, connectionString, port))
  }
}

async function handleList(): Promise<void> {
  console.log()
  const containers = await containerManager.list()

  if (containers.length === 0) {
    console.log(
      info('No containers found. Create one with the "Create" option.'),
    )
    return
  }

  // Table header
  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.bold.white('NAME'.padEnd(20)) +
      chalk.bold.white('ENGINE'.padEnd(12)) +
      chalk.bold.white('VERSION'.padEnd(10)) +
      chalk.bold.white('PORT'.padEnd(8)) +
      chalk.bold.white('STATUS'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(60)))

  // Table rows
  for (const container of containers) {
    const statusDisplay =
      container.status === 'running'
        ? chalk.green('● running')
        : chalk.gray('○ stopped')

    console.log(
      chalk.gray('  ') +
        chalk.cyan(container.name.padEnd(20)) +
        chalk.white(container.engine.padEnd(12)) +
        chalk.yellow(container.version.padEnd(10)) +
        chalk.green(String(container.port).padEnd(8)) +
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

async function handleConnect(): Promise<void> {
  const containers = await containerManager.list()
  const running = containers.filter((c) => c.status === 'running')

  if (running.length === 0) {
    console.log(warning('No running containers'))
    return
  }

  const containerName = await promptContainerSelect(
    running,
    'Select container to connect to:',
  )
  if (!containerName) return

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)
  const connectionString = engine.getConnectionString(config)

  console.log(info(`Connecting to ${containerName}...`))
  console.log()

  // Spawn psql
  const psqlProcess = spawn('psql', [connectionString], {
    stdio: 'inherit',
  })

  psqlProcess.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      console.log(warning('psql not found on your system.'))
      console.log()
      console.log(chalk.gray('  Connect manually with:'))
      console.log(chalk.cyan(`  ${connectionString}`))
      console.log()
      console.log(chalk.gray('  Install PostgreSQL client:'))
      console.log(chalk.cyan('  brew install libpq && brew link --force libpq'))
    }
  })

  await new Promise<void>((resolve) => {
    psqlProcess.on('close', () => resolve())
  })
}

async function handleRestore(): Promise<void> {
  const containers = await containerManager.list()
  const running = containers.filter((c) => c.status === 'running')

  if (running.length === 0) {
    console.log(warning('No running containers. Start one first.'))
    return
  }

  const containerName = await promptContainerSelect(
    running,
    'Select container to restore to:',
  )
  if (!containerName) return

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  // Get backup file path
  const { backupPath } = await inquirer.prompt<{ backupPath: string }>([
    {
      type: 'input',
      name: 'backupPath',
      message: 'Path to backup file:',
      validate: (input: string) => {
        if (!input) return 'Backup path is required'
        if (!existsSync(input)) return 'File not found'
        return true
      },
    },
  ])

  const databaseName = await promptDatabaseName(containerName)

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
    restoreSpinner.warn('Restore completed with warnings')
  }

  const connectionString = engine.getConnectionString(config, databaseName)
  console.log()
  console.log(success(`Database "${databaseName}" restored`))
  console.log(chalk.gray('  Connection string:'))
  console.log(chalk.cyan(`  ${connectionString}`))
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

async function handleDelete(): Promise<void> {
  const containers = await containerManager.list()

  if (containers.length === 0) {
    console.log(warning('No containers found'))
    return
  }

  const containerName = await promptContainerSelect(
    containers,
    'Select container to delete:',
  )
  if (!containerName) return

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

  const isRunning = await processManager.isRunning(containerName)

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

async function handleChangePort(): Promise<void> {
  const containers = await containerManager.list()
  const stopped = containers.filter((c) => c.status !== 'running')

  if (stopped.length === 0) {
    console.log(
      warning(
        'No stopped containers. Stop a container first to change its port.',
      ),
    )
    return
  }

  const containerName = await promptContainerSelect(
    stopped,
    'Select container to change port:',
  )
  if (!containerName) return

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  console.log(chalk.gray(`  Current port: ${config.port}`))
  console.log()

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
    return
  }

  // Check if port is available
  const portAvailable = await portManager.isPortAvailable(newPort)
  if (!portAvailable) {
    console.log(warning(`Port ${newPort} is already in use`))
    return
  }

  await containerManager.updateConfig(containerName, { port: newPort })

  console.log(
    success(`Changed ${containerName} port from ${config.port} to ${newPort}`),
  )
}

export const menuCommand = new Command('menu')
  .description('Interactive menu for managing containers')
  .action(async () => {
    try {
      await showMainMenu()
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })
