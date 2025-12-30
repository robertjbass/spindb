import chalk from 'chalk'
import inquirer from 'inquirer'
import {
  existsSync,
  renameSync,
  statSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
} from 'fs'
import { dirname, basename, join, resolve } from 'path'
import { homedir } from 'os'
import { containerManager } from '../../../core/container-manager'
import { getMissingDependencies } from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { portManager } from '../../../core/port-manager'
import { processManager } from '../../../core/process-manager'
import { getEngine } from '../../../engines'
import { sqliteRegistry } from '../../../engines/sqlite/registry'
import { defaults } from '../../../config/defaults'
import { paths } from '../../../config/paths'
import {
  promptContainerName,
  promptContainerSelect,
  promptInstallDependencies,
  promptConfirm,
  promptEngine,
  promptVersion,
  promptPort,
  promptDatabaseName,
  promptSqlitePath,
  BACK_VALUE,
  MAIN_MENU_VALUE,
} from '../../ui/prompts'
import { getEngineDefaults } from '../../../config/defaults'
import { createSpinner } from '../../ui/spinner'
import {
  header,
  uiSuccess,
  uiError,
  uiWarning,
  uiInfo,
  connectionBox,
  formatBytes,
} from '../../ui/theme'
import { handleOpenShell, handleCopyConnectionString } from './shell-handlers'
import { handleRunSql, handleViewLogs } from './sql-handlers'
import { Engine } from '../../../types'
import { type MenuChoice, pressEnterToContinue } from './shared'

export async function handleCreate(): Promise<'main' | void> {
  console.log()
  console.log(header('Create New Database Container'))
  console.log()

  // Wizard state - all values start as null
  let selectedEngine: string | null = null
  let selectedVersion: string | null = null
  let containerName: string | null = null
  let sqlitePath: string | undefined = undefined

  // Step 1: Engine selection (back returns to main menu)
  while (selectedEngine === null) {
    const result = await promptEngine({ includeBack: true })
    if (result === MAIN_MENU_VALUE) return 'main'
    if (result === BACK_VALUE) return // Back to parent menu
    selectedEngine = result
  }

  // Step 2: Version selection (back returns to engine)
  while (selectedVersion === null) {
    const result = await promptVersion(selectedEngine!, { includeBack: true })
    if (result === MAIN_MENU_VALUE) return 'main'
    if (result === BACK_VALUE) {
      selectedEngine = null
      continue
    }
    selectedVersion = result
  }

  // Step 3: Container name (back returns to version)
  while (containerName === null) {
    const result = await promptContainerName(undefined, { allowBack: true })
    if (result === null) {
      selectedVersion = null
      continue
    }
    containerName = result
  }

  // At this point, all wizard values are guaranteed to be set
  const engine = selectedEngine!
  const version = selectedVersion!
  const name = containerName!

  // Step 4: Database name (defaults to container name, sanitized)
  const database = await promptDatabaseName(name, engine)

  // Step 5: Port or SQLite path
  const isSQLite = engine === 'sqlite'
  let port: number
  if (isSQLite) {
    // SQLite doesn't need a port, but needs a path
    sqlitePath = await promptSqlitePath(name)
    port = 0
  } else {
    const engineDefaults = getEngineDefaults(engine)
    port = await promptPort(engineDefaults.defaultPort)
  }

  // Now we have all values - proceed with container creation
  let containerNameFinal = name

  console.log()
  console.log(header('Creating Database Container'))
  console.log()

  const dbEngine = getEngine(engine)
  const isPostgreSQL = engine === 'postgresql'

  // For PostgreSQL, download binaries FIRST - they include client tools (psql, pg_dump, etc.)
  // This avoids requiring a separate system installation of client tools
  let portAvailable = true
  if (isPostgreSQL) {
    portAvailable = await portManager.isPortAvailable(port)

    const binarySpinner = createSpinner(
      `Checking ${dbEngine.displayName} ${version} binaries...`,
    )
    binarySpinner.start()

    const isInstalled = await dbEngine.isBinaryInstalled(version)
    if (isInstalled) {
      binarySpinner.succeed(
        `${dbEngine.displayName} ${version} binaries ready (cached)`,
      )
    } else {
      binarySpinner.text = `Downloading ${dbEngine.displayName} ${version} binaries...`
      await dbEngine.ensureBinaries(version, ({ message }) => {
        binarySpinner.text = message
      })
      binarySpinner.succeed(
        `${dbEngine.displayName} ${version} binaries downloaded`,
      )
    }
  }

  // Check dependencies (all engines need this)
  // For PostgreSQL, this runs AFTER binary download so client tools are available
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
      console.log()
      console.log(
        uiWarning(
          'Container creation cancelled - required tools not installed.',
        ),
      )
      await pressEnterToContinue()
      return
    }

    missingDeps = await getMissingDependencies(engine)
    if (missingDeps.length > 0) {
      console.log(
        uiError(
          `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
        ),
      )
      await pressEnterToContinue()
      return
    }

    console.log(chalk.green('  ✓ All required tools are now available'))
    console.log()
  } else {
    depsSpinner.succeed('Required tools available')
  }

  // Server databases (MySQL): check port and binaries
  // PostgreSQL already handled above
  if (!isSQLite && !isPostgreSQL) {
    portAvailable = await portManager.isPortAvailable(port)

    const binarySpinner = createSpinner(
      `Checking ${dbEngine.displayName} ${version} binaries...`,
    )
    binarySpinner.start()

    const isInstalled = await dbEngine.isBinaryInstalled(version)
    if (isInstalled) {
      binarySpinner.succeed(
        `${dbEngine.displayName} ${version} binaries ready (cached)`,
      )
    } else {
      binarySpinner.text = `Downloading ${dbEngine.displayName} ${version} binaries...`
      await dbEngine.ensureBinaries(version, ({ message }) => {
        binarySpinner.text = message
      })
      binarySpinner.succeed(
        `${dbEngine.displayName} ${version} binaries downloaded`,
      )
    }
  }

  while (await containerManager.exists(containerNameFinal)) {
    console.log(
      chalk.yellow(`  Container "${containerNameFinal}" already exists.`),
    )
    const newName = await promptContainerName(undefined, { allowBack: true })
    if (!newName) {
      console.log(chalk.blue('  Container creation cancelled.'))
      return
    }
    containerNameFinal = newName
  }

  const createSpinnerInstance = createSpinner('Creating container...')
  createSpinnerInstance.start()

  await containerManager.create(containerNameFinal, {
    engine: dbEngine.name as Engine,
    version,
    port,
    database,
  })

  createSpinnerInstance.succeed('Container created')

  const initSpinner = createSpinner(
    isSQLite ? 'Creating database file...' : 'Initializing database cluster...',
  )
  initSpinner.start()

  await dbEngine.initDataDir(containerNameFinal, version, {
    superuser: defaults.superuser,
    path: sqlitePath, // SQLite file path (undefined for server databases)
  })

  initSpinner.succeed(
    isSQLite ? 'Database file created' : 'Database cluster initialized',
  )

  // SQLite: show file path, no start needed
  if (isSQLite) {
    const config = await containerManager.getConfig(containerNameFinal)
    if (config) {
      const connectionString = dbEngine.getConnectionString(config)
      console.log()
      console.log(uiSuccess('Database Created'))
      console.log()
      console.log(chalk.gray(`  Container: ${containerNameFinal}`))
      console.log(chalk.gray(`  Engine: ${dbEngine.displayName} ${version}`))
      console.log(chalk.gray(`  File: ${config.database}`))
      console.log()
      console.log(uiSuccess(`Available at ${config.database}`))
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
    return
  }

  // Server databases: start and create database
  if (portAvailable) {
    const startSpinner = createSpinner(`Starting ${dbEngine.displayName}...`)
    startSpinner.start()

    const config = await containerManager.getConfig(containerNameFinal)
    if (config) {
      await dbEngine.start(config)
      await containerManager.updateConfig(containerNameFinal, {
        status: 'running',
      })
    }

    startSpinner.succeed(`${dbEngine.displayName} started`)

    // Skip creating 'postgres' database for PostgreSQL - it's created by initdb
    // For other engines (MySQL, SQLite), allow creating a database named 'postgres'
    if (
      config &&
      !(config.engine === 'postgresql' && database === 'postgres')
    ) {
      const dbSpinner = createSpinner(`Creating database "${database}"...`)
      dbSpinner.start()

      await dbEngine.createDatabase(config, database)

      dbSpinner.succeed(`Database "${database}" created`)
    }

    if (config) {
      const connectionString = dbEngine.getConnectionString(config)
      console.log()
      console.log(uiSuccess('Database Created'))
      console.log()
      console.log(chalk.gray(`  Container: ${containerNameFinal}`))
      console.log(chalk.gray(`  Engine: ${dbEngine.displayName} ${version}`))
      console.log(chalk.gray(`  Database: ${database}`))
      console.log(chalk.gray(`  Port: ${port}`))
      console.log()
      console.log(uiSuccess(`Running on port ${port}`))
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
      uiWarning(
        `Port ${port} is currently in use. Container created but not started.`,
      ),
    )
    console.log(
      uiInfo(
        `Start it later with: ${chalk.cyan(`spindb start ${containerNameFinal}`)}`,
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
      uiInfo('No containers found. Create one with the "Create" option.'),
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
      chalk.bold.white('NAME'.padEnd(16)) +
      chalk.bold.white('ENGINE'.padEnd(11)) +
      chalk.bold.white('VERSION'.padEnd(8)) +
      chalk.bold.white('PORT'.padEnd(6)) +
      chalk.bold.white('SIZE'.padEnd(9)) +
      chalk.bold.white('STATUS'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(58)))

  for (let i = 0; i < containers.length; i++) {
    const container = containers[i]
    const size = sizes[i]
    const isSQLite = container.engine === Engine.SQLite

    // SQLite uses available/missing, server databases use running/stopped
    const statusDisplay = isSQLite
      ? container.status === 'running'
        ? chalk.blue('● available')
        : chalk.gray('○ missing')
      : container.status === 'running'
        ? chalk.green('● running')
        : chalk.gray('○ stopped')

    const sizeDisplay = size !== null ? formatBytes(size) : chalk.gray('—')

    // Truncate name if too long
    const displayName =
      container.name.length > 15
        ? container.name.slice(0, 14) + '…'
        : container.name

    // SQLite shows dash instead of port
    const portDisplay = isSQLite ? '—' : String(container.port)

    console.log(
      chalk.gray('  ') +
        chalk.cyan(displayName.padEnd(16)) +
        chalk.white(container.engine.padEnd(11)) +
        chalk.yellow(container.version.padEnd(8)) +
        chalk.green(portDisplay.padEnd(6)) +
        chalk.magenta(sizeDisplay.padEnd(9)) +
        statusDisplay,
    )
  }

  console.log()

  // Separate counts for server databases and SQLite
  const serverContainers = containers.filter((c) => c.engine !== Engine.SQLite)
  const sqliteContainers = containers.filter((c) => c.engine === Engine.SQLite)

  const running = serverContainers.filter((c) => c.status === 'running').length
  const stopped = serverContainers.filter((c) => c.status !== 'running').length
  const available = sqliteContainers.filter(
    (c) => c.status === 'running',
  ).length
  const missing = sqliteContainers.filter((c) => c.status !== 'running').length

  const parts: string[] = []
  if (serverContainers.length > 0) {
    parts.push(`${running} running, ${stopped} stopped`)
  }
  if (sqliteContainers.length > 0) {
    parts.push(
      `${available} SQLite available${missing > 0 ? `, ${missing} missing` : ''}`,
    )
  }

  console.log(
    chalk.gray(`  ${containers.length} container(s): ${parts.join('; ')}`),
  )

  console.log()
  const containerChoices = [
    ...containers.map((c) => {
      // Simpler selector - table already shows details
      const statusLabel =
        c.engine === Engine.SQLite
          ? c.status === 'running'
            ? chalk.blue('● available')
            : chalk.gray('○ missing')
          : c.status === 'running'
            ? chalk.green('● running')
            : chalk.gray('○ stopped')

      return {
        name: `${c.name} ${statusLabel}`,
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
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  // SQLite: Check file existence instead of running status
  const isSQLite = config.engine === Engine.SQLite
  let isRunning: boolean
  let status: string
  let locationInfo: string

  if (isSQLite) {
    const fileExists = existsSync(config.database)
    isRunning = fileExists // For SQLite, "running" means "file exists"
    status = fileExists ? 'available' : 'missing'
    locationInfo = `at ${config.database}`
  } else {
    isRunning = await processManager.isRunning(containerName, {
      engine: config.engine,
    })
    status = isRunning ? 'running' : 'stopped'
    locationInfo = `on port ${config.port}`
  }

  console.clear()
  console.log(header(containerName))
  console.log()
  console.log(
    chalk.gray(
      `  ${config.engine} ${config.version} ${locationInfo} - ${status}`,
    ),
  )
  console.log()

  // Build action choices based on engine type
  const actionChoices: MenuChoice[] = []

  // Start/Stop buttons only for server databases (not SQLite)
  if (!isSQLite) {
    if (!isRunning) {
      actionChoices.push({
        name: `${chalk.green('▶')} Start container`,
        value: 'start',
      })
    } else {
      actionChoices.push({
        name: `${chalk.red('■')} Stop container`,
        value: 'stop',
      })
    }
  }

  // Open shell - always enabled for SQLite (if file exists), server databases need to be running
  const canOpenShell = isSQLite ? existsSync(config.database) : isRunning
  actionChoices.push({
    name: canOpenShell
      ? `${chalk.blue('⌘')} Open shell`
      : chalk.gray('⌘ Open shell'),
    value: 'shell',
    disabled: canOpenShell
      ? false
      : isSQLite
        ? 'Database file missing'
        : 'Start container first',
  })

  // Run SQL/script - always enabled for SQLite (if file exists), server databases need to be running
  const canRunSql = isSQLite ? existsSync(config.database) : isRunning
  // MongoDB uses JavaScript scripts, not SQL
  const runScriptLabel =
    config.engine === 'mongodb' ? 'Run script file' : 'Run SQL file'
  actionChoices.push({
    name: canRunSql
      ? `${chalk.yellow('▷')} ${runScriptLabel}`
      : chalk.gray(`▷ ${runScriptLabel}`),
    value: 'run-sql',
    disabled: canRunSql
      ? false
      : isSQLite
        ? 'Database file missing'
        : 'Start container first',
  })

  // Edit container - SQLite can always edit (no running state), server databases must be stopped
  const canEdit = isSQLite ? true : !isRunning
  actionChoices.push({
    name: canEdit
      ? `${chalk.white('⚙')} Edit container`
      : chalk.gray('⚙ Edit container'),
    value: 'edit',
    disabled: canEdit ? false : 'Stop container first',
  })

  // Clone container - SQLite can always clone, server databases must be stopped
  const canClone = isSQLite ? true : !isRunning
  actionChoices.push({
    name: canClone
      ? `${chalk.cyan('⧉')} Clone container`
      : chalk.gray('⧉ Clone container'),
    value: 'clone',
    disabled: canClone ? false : 'Stop container first',
  })

  actionChoices.push({
    name: `${chalk.magenta('⎘')} Copy connection string`,
    value: 'copy',
  })

  // View logs - not available for SQLite (no log file)
  if (!isSQLite) {
    actionChoices.push({
      name: `${chalk.gray('☰')} View logs`,
      value: 'logs',
    })
  }

  // Detach - only for SQLite (unregisters without deleting file)
  if (isSQLite) {
    actionChoices.push({
      name: `${chalk.yellow('⊘')} Detach from SpinDB`,
      value: 'detach',
    })
  }

  // Delete container - SQLite can always delete, server databases must be stopped
  const canDelete = isSQLite ? true : !isRunning
  actionChoices.push({
    name: canDelete
      ? `${chalk.red('✕')} Delete container`
      : chalk.gray('✕ Delete container'),
    value: 'delete',
    disabled: canDelete ? false : 'Stop container first',
  })

  actionChoices.push(
    new inquirer.Separator(),
    {
      name: `${chalk.blue('←')} Back to containers`,
      value: 'back',
    },
    {
      name: `${chalk.blue('⌂')} Back to main menu`,
      value: 'main',
    },
  )

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
    case 'detach':
      await handleDetachContainer(containerName, showMainMenu)
      return // Return to list after detach
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
  // Filter for stopped containers, excluding SQLite (no server process to start)
  const stopped = containers.filter(
    (c) => c.status !== 'running' && c.engine !== Engine.SQLite,
  )

  if (stopped.length === 0) {
    console.log(uiWarning('All containers are already running'))
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
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  const portAvailable = await portManager.isPortAvailable(config.port)
  if (!portAvailable) {
    const { port: newPort } = await portManager.findAvailablePort()
    console.log(
      uiWarning(`Port ${config.port} is in use, switching to port ${newPort}`),
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
  // Filter for running containers, excluding SQLite (no server process to stop)
  const running = containers.filter(
    (c) => c.status === 'running' && c.engine !== Engine.SQLite,
  )

  if (running.length === 0) {
    console.log(uiWarning('No running containers'))
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
    console.error(uiError(`Container "${containerName}" not found`))
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
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  const portAvailable = await portManager.isPortAvailable(config.port)
  if (!portAvailable) {
    console.log(
      uiWarning(
        `Port ${config.port} is in use. Stop the process using it or change this container's port.`,
      ),
    )
    console.log()
    console.log(
      uiInfo(
        'Tip: If you installed MariaDB via apt, it may have started a system service.',
      ),
    )
    console.log(
      uiInfo(
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
  } catch (error) {
    spinner.fail(`Failed to start "${containerName}"`)
    const e = error as Error
    console.log()
    console.log(uiError(e.message))

    const logPath = paths.getContainerLogPath(containerName, {
      engine: config.engine,
    })
    if (existsSync(logPath)) {
      console.log()
      console.log(uiInfo(`Check the log file for details: ${logPath}`))
    }
  }
}

async function handleStopContainer(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
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
    console.error(uiError(`Container "${containerName}" not found`))
    return null
  }

  const isSQLite = config.engine === Engine.SQLite

  console.clear()
  console.log(header(`Edit: ${containerName}`))
  console.log()

  const editChoices: Array<
    { name: string; value: string } | inquirer.Separator
  > = [
    {
      name: `Name: ${chalk.white(containerName)}`,
      value: 'name',
    },
  ]

  // SQLite: show relocate option with file path; others: show port
  if (isSQLite) {
    editChoices.push({
      name: `Location: ${chalk.white(config.database)}`,
      value: 'relocate',
    })
  } else {
    editChoices.push({
      name: `Port: ${chalk.white(String(config.port))}`,
      value: 'port',
    })
  }

  editChoices.push(new inquirer.Separator())
  editChoices.push({
    name: `${chalk.blue('←')} Back to container`,
    value: 'back',
  })
  editChoices.push({
    name: `${chalk.blue('⌂')} Back to main menu`,
    value: 'main',
  })

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
      console.log(uiInfo('Name unchanged'))
      return await handleEditContainer(containerName)
    }

    if (await containerManager.exists(newName)) {
      console.log(uiError(`Container "${newName}" already exists`))
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
      console.log(uiInfo('Port unchanged'))
      return await handleEditContainer(containerName)
    }

    const portAvailable = await portManager.isPortAvailable(newPort)
    if (!portAvailable) {
      console.log(
        uiWarning(
          `Port ${newPort} is currently in use. You'll need to stop the process using it before starting this container.`,
        ),
      )
    }

    await containerManager.updateConfig(containerName, { port: newPort })
    console.log(uiSuccess(`Changed port from ${config.port} to ${newPort}`))

    // Continue editing
    return await handleEditContainer(containerName)
  }

  if (field === 'relocate') {
    const currentFileName = basename(config.database)

    const { inputPath } = await inquirer.prompt<{ inputPath: string }>([
      {
        type: 'input',
        name: 'inputPath',
        message: 'New file path:',
        default: config.database,
        validate: (input: string) => {
          if (!input) return 'Path is required'
          return true
        },
      },
    ])

    // Expand ~ to home directory
    let expandedPath = inputPath
    if (inputPath === '~') {
      expandedPath = homedir()
    } else if (inputPath.startsWith('~/')) {
      expandedPath = join(homedir(), inputPath.slice(2))
    }

    // Convert relative paths to absolute
    if (!expandedPath.startsWith('/')) {
      expandedPath = resolve(process.cwd(), expandedPath)
    }

    // Check if path looks like a file (has db extension) or directory
    const hasDbExtension = /\.(sqlite3?|db)$/i.test(expandedPath)

    // Treat as directory if:
    // - ends with /
    // - exists and is a directory
    // - doesn't have a database file extension (assume it's a directory path)
    const isDirectory =
      expandedPath.endsWith('/') ||
      (existsSync(expandedPath) && statSync(expandedPath).isDirectory()) ||
      !hasDbExtension

    let finalPath: string
    if (isDirectory) {
      // Remove trailing slash if present, then append filename
      const dirPath = expandedPath.endsWith('/')
        ? expandedPath.slice(0, -1)
        : expandedPath
      finalPath = join(dirPath, currentFileName)
    } else {
      finalPath = expandedPath
    }

    if (finalPath === config.database) {
      console.log(uiInfo('Location unchanged'))
      return await handleEditContainer(containerName)
    }

    // Check if source file exists
    if (!existsSync(config.database)) {
      console.log(uiError(`Source file not found: ${config.database}`))
      return await handleEditContainer(containerName)
    }

    // Check if destination already exists
    if (existsSync(finalPath)) {
      console.log(uiError(`Destination file already exists: ${finalPath}`))
      return await handleEditContainer(containerName)
    }

    // Check if destination directory exists
    const destDir = dirname(finalPath)
    if (!existsSync(destDir)) {
      console.log(uiWarning(`Directory does not exist: ${destDir}`))
      const { createDir } = await inquirer.prompt<{ createDir: string }>([
        {
          type: 'list',
          name: 'createDir',
          message: 'Create this directory?',
          choices: [
            { name: 'Yes, create it', value: 'yes' },
            { name: 'No, cancel', value: 'no' },
          ],
        },
      ])

      if (createDir !== 'yes') {
        return await handleEditContainer(containerName)
      }

      try {
        mkdirSync(destDir, { recursive: true })
        console.log(uiSuccess(`Created directory: ${destDir}`))
      } catch (mkdirError) {
        console.log(
          uiError(
            `Failed to create directory: ${(mkdirError as Error).message}`,
          ),
        )
        return await handleEditContainer(containerName)
      }
    }

    const spinner = createSpinner('Moving database file...')
    spinner.start()

    try {
      // Try rename first (fast, same filesystem)
      try {
        renameSync(config.database, finalPath)
      } catch (renameErr) {
        const e = renameErr as NodeJS.ErrnoException
        // EXDEV = cross-device link, need to copy+delete
        if (e.code === 'EXDEV') {
          try {
            // Copy file preserving mode/permissions
            copyFileSync(config.database, finalPath)
            // Only delete source after successful copy
            unlinkSync(config.database)
          } catch (copyErr) {
            // Clean up partial target on failure
            if (existsSync(finalPath)) {
              try {
                unlinkSync(finalPath)
              } catch {
                // Ignore cleanup errors
              }
            }
            throw copyErr
          }
        } else {
          throw renameErr
        }
      }

      // Update the container config and SQLite registry
      await containerManager.updateConfig(containerName, {
        database: finalPath,
      })
      await sqliteRegistry.update(containerName, { filePath: finalPath })
      spinner.succeed(`Moved database to ${finalPath}`)

      // Wait for user to see success message before refreshing
      await pressEnterToContinue()
    } catch (error) {
      spinner.fail('Failed to move database file')
      console.log(uiError((error as Error).message))
      await pressEnterToContinue()
    }

    // Continue editing (will fetch fresh config)
    return await handleEditContainer(containerName)
  }

  return containerName
}

async function handleCloneFromSubmenu(
  sourceName: string,
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const sourceConfig = await containerManager.getConfig(sourceName)
  if (!sourceConfig) {
    console.log(uiError(`Container "${sourceName}" not found`))
    return
  }

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

  // Check if target container already exists
  if (
    await containerManager.exists(targetName, { engine: sourceConfig.engine })
  ) {
    console.log(uiError(`Container "${targetName}" already exists`))
    return
  }

  const spinner = createSpinner(`Cloning ${sourceName} to ${targetName}...`)
  spinner.start()

  try {
    const newConfig = await containerManager.clone(sourceName, targetName)

    spinner.succeed(`Cloned "${sourceName}" to "${targetName}"`)

    const engine = getEngine(newConfig.engine)
    const connectionString = engine.getConnectionString(newConfig)

    console.log()
    console.log(connectionBox(targetName, connectionString, newConfig.port))

    await showContainerSubmenu(targetName, showMainMenu)
  } catch (error) {
    spinner.fail(`Failed to clone "${sourceName}"`)
    console.log(uiError((error as Error).message))
    await pressEnterToContinue()
  }
}

async function handleDetachContainer(
  containerName: string,
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const confirmed = await promptConfirm(
    `Detach "${containerName}" from SpinDB? (file will be kept on disk)`,
    true,
  )

  if (!confirmed) {
    console.log(uiWarning('Cancelled'))
    await pressEnterToContinue()
    await showContainerSubmenu(containerName, showMainMenu)
    return
  }

  const entry = await sqliteRegistry.get(containerName)
  await sqliteRegistry.remove(containerName)

  console.log(uiSuccess(`Detached "${containerName}" from SpinDB`))
  if (entry?.filePath) {
    console.log(chalk.gray(`  File remains at: ${entry.filePath}`))
    console.log()
    console.log(chalk.gray('  Re-attach with:'))
    console.log(chalk.cyan(`    spindb attach ${entry.filePath}`))
  }
  await pressEnterToContinue()
  await handleList(showMainMenu)
}

async function handleDelete(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  const confirmed = await promptConfirm(
    `Are you sure you want to delete "${containerName}"? This cannot be undone.`,
    false,
  )

  if (!confirmed) {
    console.log(uiWarning('Deletion cancelled'))
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
