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
import { readdir, rm, lstat } from 'fs/promises'
import { spawn } from 'child_process'
import { join } from 'path'
import { paths } from '@/config/paths'

type MenuChoice = {
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

  const canStart = stopped > 0
  const canStop = running > 0
  const canConnect = running > 0
  const canRestore = running > 0
  const canClone = containers.length > 0

  // If containers exist, show List first; otherwise show Create first
  const hasContainers = containers.length > 0

  const choices: MenuChoice[] = [
    ...(hasContainers
      ? [
          { name: `${chalk.cyan('◉')} List containers`, value: 'list' },
          { name: `${chalk.green('+')} Create new container`, value: 'create' },
        ]
      : [
          { name: `${chalk.green('+')} Create new container`, value: 'create' },
          { name: `${chalk.cyan('◉')} List containers`, value: 'list' },
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
        ? `${chalk.yellow('■')} Stop a container`
        : chalk.gray('■ Stop a container'),
      value: 'stop',
      disabled: canStop ? false : 'No running containers',
    },
    {
      name: canConnect
        ? `${chalk.blue('⌘')} Open psql shell`
        : chalk.gray('⌘ Open psql shell'),
      value: 'connect',
      disabled: canConnect ? false : 'No running containers',
    },
    {
      name: canRestore
        ? `${chalk.magenta('↓')} Restore backup`
        : chalk.gray('↓ Restore backup'),
      value: 'restore',
      disabled: canRestore ? false : 'No running containers',
    },
    {
      name: canClone
        ? `${chalk.cyan('⧉')} Clone a container`
        : chalk.gray('⧉ Clone a container'),
      value: 'clone',
      disabled: canClone ? false : 'No containers',
    },
    { name: `${chalk.yellow('⚙')} Engines`, value: 'engines' },
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
    case 'engines':
      await handleEngines()
      break
    case 'exit':
      console.log(chalk.gray('\n  Goodbye!\n'))
      process.exit(0)
  }

  // Return to menu after action
  await showMainMenu()
}

async function handleCreate(): Promise<void> {
  console.log()
  const answers = await promptCreateOptions()
  const { name: containerName, engine, version, port, database } = answers

  console.log()
  console.log(header('Creating Database Container'))
  console.log()

  const dbEngine = getEngine(engine)

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

  // Create container
  const createSpinnerInstance = createSpinner('Creating container...')
  createSpinnerInstance.start()

  await containerManager.create(containerName, {
    engine: dbEngine.name,
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
      console.log(connectionBox(containerName, connectionString, port))
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

  // Container selection with submenu
  console.log()
  const containerChoices = [
    ...containers.map((c) => ({
      name: `${c.name} ${chalk.gray(`(${c.engine} ${c.version}, port ${c.port})`)} ${
        c.status === 'running'
          ? chalk.green('● running')
          : chalk.gray('○ stopped')
      }`,
      value: c.name,
      short: c.name,
    })),
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
  const isRunning = await processManager.isRunning(containerName)
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
      : { name: `${chalk.yellow('■')} Stop container`, value: 'stop' },
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
    { name: `${chalk.red('✕')} Delete container`, value: 'delete' },
    new inquirer.Separator(),
    { name: `${chalk.blue('←')} Back to container list`, value: 'back' },
    { name: `${chalk.blue('🏠')} Back to main menu`, value: 'main' },
  ]

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: actionChoices,
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

  // Copy to clipboard using platform-specific command
  const { platform } = await import('os')
  const cmd = platform() === 'darwin' ? 'pbcopy' : 'xclip'
  const args = platform() === 'darwin' ? [] : ['-selection', 'clipboard']

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] })
      proc.stdin?.write(connectionString)
      proc.stdin?.end()
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Clipboard command exited with code ${code}`))
      })
      proc.on('error', reject)
    })

    console.log()
    console.log(success('Connection string copied to clipboard'))
    console.log(chalk.gray(`  ${connectionString}`))
  } catch {
    // Fallback: just display the string
    console.log()
    console.log(warning('Could not copy to clipboard. Connection string:'))
    console.log(chalk.cyan(`  ${connectionString}`))
  }
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
    return
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
    { name: `${chalk.blue('🏠')} Back to main menu`, value: 'main' },
  ]

  const { field } = await inquirer.prompt<{ field: string }>([
    {
      type: 'list',
      name: 'field',
      message: 'Select field to edit:',
      choices: editChoices,
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

type InstalledEngine = {
  engine: string
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
}

async function getInstalledEngines(): Promise<InstalledEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledEngine[] = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Parse directory name: postgresql-17-darwin-arm64
      const match = entry.name.match(/^(\w+)-(.+)-(\w+)-(\w+)$/)
      if (match) {
        const [, engine, version, platform, arch] = match
        const dirPath = join(binDir, entry.name)

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
          engine,
          version,
          platform,
          arch,
          path: dirPath,
          sizeBytes,
        })
      }
    }
  }

  // Sort by engine name, then by version (descending)
  engines.sort((a, b) => {
    if (a.engine !== b.engine) return a.engine.localeCompare(b.engine)
    return compareVersions(b.version, a.version)
  })

  return engines
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
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
        '  Engines are downloaded automatically when you create a container.',
      ),
    )
    return
  }

  // Calculate total size
  const totalSize = engines.reduce((acc, e) => acc + e.sizeBytes, 0)

  // Table header
  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.bold.white('ENGINE'.padEnd(12)) +
      chalk.bold.white('VERSION'.padEnd(12)) +
      chalk.bold.white('PLATFORM'.padEnd(20)) +
      chalk.bold.white('SIZE'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(55)))

  // Table rows
  for (const engine of engines) {
    console.log(
      chalk.gray('  ') +
        chalk.cyan(engine.engine.padEnd(12)) +
        chalk.yellow(engine.version.padEnd(12)) +
        chalk.gray(`${engine.platform}-${engine.arch}`.padEnd(20)) +
        chalk.white(formatBytes(engine.sizeBytes)),
    )
  }

  console.log(chalk.gray('  ' + '─'.repeat(55)))
  console.log(
    chalk.gray('  ') +
      chalk.bold.white(`${engines.length} version(s)`.padEnd(44)) +
      chalk.bold.white(formatBytes(totalSize)),
  )
  console.log()

  // Menu options
  const choices: MenuChoice[] = [
    ...engines.map((e) => ({
      name: `${chalk.red('✕')} Delete ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `delete:${e.path}:${e.engine}:${e.version}`,
    })),
    new inquirer.Separator(),
    { name: `${chalk.blue('←')} Back to main menu`, value: 'back' },
  ]

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
