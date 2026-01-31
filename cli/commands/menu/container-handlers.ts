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
import { stat, mkdir, rm } from 'fs/promises'
import { dirname, basename, join, resolve } from 'path'
import { homedir } from 'os'
import { containerManager } from '../../../core/container-manager'
import { getMissingDependencies } from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { portManager } from '../../../core/port-manager'
import { processManager } from '../../../core/process-manager'
import { getEngine } from '../../../engines'
import { sqliteRegistry } from '../../../engines/sqlite/registry'
import { duckdbRegistry } from '../../../engines/duckdb/registry'
import { defaults } from '../../../config/defaults'
import { getPageSize } from '../../constants'
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
  promptFileDatabasePath,
  escapeablePrompt,
  filterableListPrompt,
  type FilterableChoice,
  BACK_VALUE,
  MAIN_MENU_VALUE,
  TOGGLE_PREFIX,
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
  box,
} from '../../ui/theme'
import { handleOpenShell, handleCopyConnectionString } from './shell-handlers'
import { handleRunSql, handleViewLogs } from './sql-handlers'
import {
  handleBackupForContainer,
  handleRestoreForContainer,
} from './backup-handlers'
import {
  exportToDocker,
  getExportBackupPath,
} from '../../../core/docker-exporter'
import { getDefaultFormat } from '../../../config/backup-formats'
import { Engine, isFileBasedEngine } from '../../../types'
import { type MenuChoice, pressEnterToContinue } from './shared'
import { getEngineIcon } from '../../constants'

export async function handleCreate(): Promise<'main' | void> {
  console.log()
  console.log(header('Create New Database Container'))
  console.log()

  // Wizard state - all values start as null
  let selectedEngine: string | null = null
  let selectedVersion: string | null = null
  let containerName: string | null = null

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
  // Redis and Valkey use numbered databases 0-15, so skip prompt and default to "0"
  // Qdrant uses collections (not databases), so default to "default"
  // Meilisearch uses indexes (not databases), so default to "default"
  let database: string
  if (engine === 'redis' || engine === 'valkey') {
    database = '0'
  } else if (engine === 'qdrant' || engine === 'meilisearch') {
    database = 'default'
  } else {
    database = await promptDatabaseName(name, engine)
  }

  // Step 5: Port or file path (SQLite/DuckDB)
  const isSQLite = engine === 'sqlite'
  const isDuckDB = engine === 'duckdb'
  const isFileBasedDB = isSQLite || isDuckDB
  let port: number
  let filePath: string | undefined = undefined
  if (isFileBasedDB) {
    // File-based databases don't need a port, but need a path
    const defaultExtension = isDuckDB ? '.duckdb' : '.sqlite'
    filePath = await promptFileDatabasePath(name, defaultExtension)
    port = 0
  } else {
    const engineDefaults = getEngineDefaults(engine)
    port = await promptPort(engineDefaults.defaultPort, engine)
  }

  // Now we have all values - proceed with container creation
  let containerNameFinal = name

  console.log()
  console.log(header('Creating Database Container'))
  console.log()

  const dbEngine = getEngine(engine)
  const isPostgreSQL = engine === 'postgresql'

  // For PostgreSQL and file-based DBs, download binaries FIRST
  // They include client tools needed for subsequent operations
  let portAvailable = true
  if (isPostgreSQL || isFileBasedDB) {
    if (!isFileBasedDB) {
      portAvailable = await portManager.isPortAvailable(port)
    }

    const binarySpinner = createSpinner(
      `Checking ${dbEngine.displayName} ${version} binaries...`,
    )
    binarySpinner.start()

    try {
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
    } catch (error) {
      binarySpinner.fail(`Failed to download ${dbEngine.displayName} binaries`)
      const e = error as Error
      console.log()
      console.log(uiError(e.message))
      console.log()
      await pressEnterToContinue()
      return
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
  if (!isFileBasedDB && !isPostgreSQL) {
    portAvailable = await portManager.isPortAvailable(port)

    const binarySpinner = createSpinner(
      `Checking ${dbEngine.displayName} ${version} binaries...`,
    )
    binarySpinner.start()

    try {
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
    } catch (error) {
      binarySpinner.fail(`Failed to download ${dbEngine.displayName} binaries`)
      const e = error as Error
      console.log()
      console.log(uiError(e.message))
      console.log()
      await pressEnterToContinue()
      return
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
    isFileBasedDB
      ? 'Creating database file...'
      : 'Initializing database cluster...',
  )
  initSpinner.start()

  await dbEngine.initDataDir(containerNameFinal, version, {
    superuser: defaults.superuser,
    path: filePath, // File-based DB path (undefined for server databases)
  })

  initSpinner.succeed(
    isFileBasedDB ? 'Database file created' : 'Database cluster initialized',
  )

  // File-based databases (SQLite/DuckDB): show file path, no start needed
  if (isFileBasedDB) {
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

      await escapeablePrompt([
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
      !(config.engine === Engine.PostgreSQL && database === 'postgres')
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

      await escapeablePrompt([
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

  const spinner = createSpinner('Loading containers...')
  spinner.start()

  const containers = await containerManager.list()

  if (containers.length === 0) {
    spinner.stop()
    console.log(
      uiInfo('No containers found. Create one with the "Create" option.'),
    )
    console.log()

    await escapeablePrompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('Press Enter to return to the main menu...'),
      },
    ])
    return
  }

  // Fetch sizes for running containers
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

  spinner.stop()

  // Column widths for formatting
  const COL_NAME = 16
  const COL_ENGINE = 13
  const COL_VERSION = 8
  const COL_PORT = 6
  const COL_SIZE = 9

  // Build selectable choices with formatted display (like engines menu)
  const containerChoices: FilterableChoice[] = containers.map((c, i) => {
    const size = sizes[i]
    const isFileBased = isFileBasedEngine(c.engine)

    // Status display
    const statusDisplay = isFileBased
      ? c.status === 'running'
        ? chalk.blue('● available')
        : chalk.gray('○ missing')
      : c.status === 'running'
        ? chalk.green('● running')
        : chalk.gray('○ stopped')

    // Truncate name if too long
    const displayName =
      c.name.length > COL_NAME - 1
        ? c.name.slice(0, COL_NAME - 2) + '…'
        : c.name

    // Port or dash for file-based
    const portDisplay = isFileBased ? '—' : String(c.port)

    // Size display
    const sizeDisplay = size !== null ? formatBytes(size) : '—'

    // Build formatted row
    // Pad icon and engine name separately to avoid emoji width calculation issues
    // (padEnd counts code points, not visual width)
    const icon = getEngineIcon(c.engine)
    const engineName = c.engine.padEnd(COL_ENGINE)
    const row =
      chalk.cyan(displayName.padEnd(COL_NAME)) +
      chalk.white(`${icon}${engineName}`) +
      chalk.yellow(c.version.padEnd(COL_VERSION)) +
      chalk.green(portDisplay.padEnd(COL_PORT)) +
      chalk.magenta(sizeDisplay.padEnd(COL_SIZE)) +
      statusDisplay

    return {
      name: row,
      value: c.name,
      short: c.name,
    }
  })

  // Calculate summary
  const serverContainers = containers.filter(
    (c) => !isFileBasedEngine(c.engine),
  )
  const fileBasedContainers = containers.filter((c) =>
    isFileBasedEngine(c.engine),
  )
  const running = serverContainers.filter((c) => c.status === 'running').length
  const stopped = serverContainers.filter((c) => c.status !== 'running').length
  const available = fileBasedContainers.filter(
    (c) => c.status === 'running',
  ).length
  const missing = fileBasedContainers.filter(
    (c) => c.status !== 'running',
  ).length

  const parts: string[] = []
  if (serverContainers.length > 0) {
    parts.push(`${running} running, ${stopped} stopped`)
  }
  if (fileBasedContainers.length > 0) {
    parts.push(
      `${available} file-based available${missing > 0 ? `, ${missing} missing` : ''}`,
    )
  }

  // Check if there are any server-based (toggleable) containers
  const hasServerContainers = containers.some(
    (c) => !isFileBasedEngine(c.engine),
  )

  // Build hints string (bottom of list)
  const hints = hasServerContainers ? chalk.gray('[Shift]+[Tab] - toggle') : ''

  // Build the full choice list with footer items
  const summary = hints
    ? `${containers.length} container(s): ${parts.join('; ')} — ${hints}`
    : `${containers.length} container(s): ${parts.join('; ')}`
  const allChoices: (FilterableChoice | inquirer.Separator)[] = [
    ...containerChoices,
    new inquirer.Separator(),
    new inquirer.Separator(summary),
    new inquirer.Separator(),
    { name: `${chalk.green('+')} Create new`, value: 'create' },
    {
      name: `${chalk.blue('←')} Back to main menu ${chalk.gray('(esc)')}`,
      value: 'back',
    },
    new inquirer.Separator(),
  ]

  const selectedContainer = await filterableListPrompt(
    allChoices,
    `Select a container: ${chalk.gray('↑↓ pick, type to filter')}`,
    {
      filterableCount: containerChoices.length,
      pageSize: getPageSize(),
      emptyText: 'No containers match filter',
      enableToggle: hasServerContainers,
    },
  )

  // Handle toggle (Shift+Tab) - start/stop the container and refresh list
  if (selectedContainer.startsWith(TOGGLE_PREFIX)) {
    const containerName = selectedContainer.slice(TOGGLE_PREFIX.length)
    const config = await containerManager.getConfig(containerName)

    if (config && !isFileBasedEngine(config.engine)) {
      const isRunning = await processManager.isRunning(containerName, {
        engine: config.engine,
      })

      // Clear screen and show brief status
      console.clear()
      console.log(header('Containers'))

      if (isRunning) {
        await handleStopContainer(containerName)
        // Brief pause so user can see the result
        await new Promise((resolve) => setTimeout(resolve, 300))
      } else {
        const result = await handleStartContainer(containerName)
        if (result === 'home') {
          await showMainMenu()
          return
        }
        // Brief pause so user can see the result (for 'started' or 'back')
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }

    // Refresh the container list
    await handleList(showMainMenu)
    return
  }

  // Back returns to main menu (escape is handled globally)
  if (selectedContainer === 'back') {
    return
  }

  if (selectedContainer === 'create') {
    const result = await handleCreate()
    if (result === 'main') {
      await showMainMenu()
    } else {
      await handleList(showMainMenu)
    }
    return
  }

  await showContainerSubmenu(selectedContainer, showMainMenu)
}

export async function showContainerSubmenu(
  containerName: string,
  showMainMenu: () => Promise<void>,
  selectedDatabase?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  // File-based databases: Check file existence instead of running status
  const isSQLite = config.engine === Engine.SQLite
  const isDuckDB = config.engine === Engine.DuckDB
  const isFileBasedDB = isSQLite || isDuckDB
  let isRunning: boolean
  let status: string
  let locationInfo: string

  if (isFileBasedDB) {
    const fileExists = existsSync(config.database)
    isRunning = fileExists // For file-based DBs, "running" means "file exists"
    status = fileExists ? 'available' : 'missing'
    locationInfo = `at ${config.database}`
  } else {
    isRunning = await processManager.isRunning(containerName, {
      engine: config.engine,
    })
    status = isRunning ? 'running' : 'stopped'
    locationInfo = `on port ${config.port}`
  }

  // Get list of databases in this container
  const databases = config.databases || [config.database]

  // Auto-select: use provided selection, or default to primary database from config
  const activeDatabase = selectedDatabase || config.database

  // Header shows icon + container → database
  const engineIcon = getEngineIcon(config.engine)
  const headerText = `${engineIcon} ${containerName} ${chalk.gray('→')} ${activeDatabase}`

  console.clear()
  console.log(header(headerText))
  console.log(
    chalk.gray(
      `${config.engine} ${config.version} ${locationInfo} - ${status}`,
    ),
  )
  console.log()

  // Build action choices based on engine type
  const actionChoices: MenuChoice[] = []

  // Helper for disabled menu items - passes hint to inquirer's disabled property
  const disabledItem = (icon: string, label: string, hint: string) => ({
    name: chalk.gray(`${icon} ${label}`),
    value: '_disabled_',
    disabled: chalk.gray(hint), // String value shows as the reason instead of "(Disabled)"
  })

  // Determine if database-specific actions can be performed
  // Requires: database selected + (running for server DBs OR file exists for file-based DBs)
  const containerReady = isFileBasedDB ? existsSync(config.database) : isRunning
  const hasMultipleDatabases = databases.length > 1
  const canDoDbAction = !!activeDatabase && containerReady

  // Hint for disabled database actions
  const getDbActionHint = () => {
    if (!activeDatabase && hasMultipleDatabases) return 'Select database first'
    if (!containerReady) {
      return isFileBasedDB ? 'Database file missing' : 'Start container first'
    }
    return 'Select database first'
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 1: Container State
  // ─────────────────────────────────────────────────────────────────────────────

  // Start/Stop buttons only for server databases (not file-based)
  if (!isFileBasedDB) {
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

  // Database selection - show current selection or prompt to select
  // Only show if there are multiple databases
  if (hasMultipleDatabases) {
    const dbIndex = activeDatabase ? databases.indexOf(activeDatabase) + 1 : 0
    const dbLabel = activeDatabase
      ? `${chalk.cyan('◉')} Set database ${chalk.gray('|')} Current: ${chalk.white(activeDatabase)} ${chalk.gray(`(${dbIndex} of ${databases.length})`)}`
      : `${chalk.yellow('◉')} Set database`
    actionChoices.push({
      name: dbLabel,
      value: 'select-database',
    })
  }

  actionChoices.push(new inquirer.Separator())

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 2: Data Operations
  // ─────────────────────────────────────────────────────────────────────────────

  // Open shell - requires database selection for multi-db containers
  const shellHint = getDbActionHint()
  actionChoices.push(
    canDoDbAction
      ? { name: `${chalk.blue('>')} Open shell`, value: 'shell' }
      : disabledItem('>', 'Open shell', shellHint),
  )

  // Run SQL/script - requires database selection for multi-db containers
  // REST API engines (Qdrant, Meilisearch, CouchDB) don't support script files - hide the option entirely
  if (
    config.engine !== Engine.Qdrant &&
    config.engine !== Engine.Meilisearch &&
    config.engine !== Engine.CouchDB
  ) {
    // Engine-specific terminology: Redis/Valkey use commands, MongoDB/FerretDB use scripts, SurrealDB uses SurrealQL, others use SQL
    const runScriptLabel =
      config.engine === Engine.Redis || config.engine === Engine.Valkey
        ? 'Run command file'
        : config.engine === Engine.MongoDB || config.engine === Engine.FerretDB
          ? 'Run script file'
          : config.engine === Engine.SurrealDB
            ? 'Run SurrealQL file'
            : 'Run SQL file'
    const runSqlHint = getDbActionHint()
    actionChoices.push(
      canDoDbAction
        ? { name: `${chalk.yellow('▷')} ${runScriptLabel}`, value: 'run-sql' }
        : disabledItem('▷', runScriptLabel, runSqlHint),
    )
  }

  // Copy connection string - requires database selection for multi-db containers
  const copyHint = getDbActionHint()
  actionChoices.push(
    canDoDbAction
      ? { name: `${chalk.magenta('⊕')} Copy connection string`, value: 'copy' }
      : disabledItem('⊕', 'Copy connection string', copyHint),
  )

  // Backup - requires database selection for multi-db containers
  const backupHint = getDbActionHint()
  actionChoices.push(
    canDoDbAction
      ? { name: `${chalk.magenta('↓')} Backup database`, value: 'backup' }
      : disabledItem('↓', 'Backup database', backupHint),
  )

  // Restore - requires database selection for multi-db containers
  const restoreHint = getDbActionHint()
  actionChoices.push(
    canDoDbAction
      ? { name: `${chalk.magenta('↑')} Restore from backup`, value: 'restore' }
      : disabledItem('↑', 'Restore from backup', restoreHint),
  )

  // View logs - not available for file-based DBs (no log file)
  if (!isFileBasedDB) {
    actionChoices.push({
      name: `${chalk.gray('☰')} View logs`,
      value: 'logs',
    })
  }

  actionChoices.push(new inquirer.Separator())

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 3: Container Management (requires stopped)
  // ─────────────────────────────────────────────────────────────────────────────

  // Edit container - file-based DBs can always edit (no running state), server databases must be stopped
  const canEdit = isFileBasedDB ? true : !isRunning
  actionChoices.push(
    canEdit
      ? { name: `${chalk.yellow('⚙')} Edit container`, value: 'edit' }
      : disabledItem('⚙', 'Edit container', 'Stop container first'),
  )

  // Clone container - file-based DBs can always clone, server databases must be stopped
  const canClone = isFileBasedDB ? true : !isRunning
  actionChoices.push(
    canClone
      ? { name: `${chalk.cyan('◇')} Clone container`, value: 'clone' }
      : disabledItem('◇', 'Clone container', 'Stop container first'),
  )

  // Detach - only for file-based DBs (unregisters without deleting file)
  if (isFileBasedDB) {
    actionChoices.push({
      name: `${chalk.yellow('⊘')} Detach from SpinDB`,
      value: 'detach',
    })
  }

  // Delete container - file-based DBs can always delete, server databases must be stopped
  const canDelete = isFileBasedDB ? true : !isRunning
  actionChoices.push(
    canDelete
      ? { name: `${chalk.red('✕')} Delete container`, value: 'delete' }
      : disabledItem('✕', 'Delete container', 'Stop container first'),
  )

  // Export - server-based DBs must be running to backup, file-based can always export
  const canExport = isFileBasedDB ? true : isRunning
  actionChoices.push(
    canExport
      ? { name: `${chalk.cyan('↑')} Export`, value: 'export' }
      : disabledItem('⬆', 'Export', 'Start container first'),
  )

  actionChoices.push(new inquirer.Separator())

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 4: Navigation
  // ─────────────────────────────────────────────────────────────────────────────

  actionChoices.push(
    {
      name: `${chalk.blue('←')} Back to containers`,
      value: 'back',
    },
    {
      name: `${chalk.blue('⌂')} Back to main menu ${chalk.gray('(esc)')}`,
      value: 'main',
    },
  )

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: actionChoices,
      pageSize: getPageSize(),
    },
  ])

  // Escape is handled globally by the menu loop

  switch (action) {
    case 'start': {
      const result = await handleStartContainer(containerName)
      if (result === 'home') {
        await showMainMenu()
        return
      }
      await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
      return
    }
    case 'stop':
      await handleStopContainer(containerName)
      await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
      return
    case 'select-database': {
      const result = await handleSelectDatabase(
        containerName,
        databases,
        config.database,
      )
      if (result.action === 'home') {
        await showMainMenu()
        return
      }
      if (result.action === 'back') {
        await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
        return
      }
      if (result.action === 'change-default') {
        await handleChangeDefaultDatabase(
          containerName,
          databases,
          config.database,
        )
        await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
        return
      }
      // action === 'select'
      await showContainerSubmenu(containerName, showMainMenu, result.database)
      return
    }
    case 'shell':
      await handleOpenShell(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
      return
    case 'run-sql':
      await handleRunSql(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
      return
    case 'logs':
      await handleViewLogs(containerName)
      await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
      return
    case 'edit': {
      const newName = await handleEditContainer(containerName)
      if (newName === null) {
        // User chose to go back to main menu
        return
      }
      if (newName !== containerName) {
        // Container was renamed, show submenu with new name
        await showContainerSubmenu(newName, showMainMenu, activeDatabase)
      } else {
        await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
      }
      return
    }
    case 'clone':
      await handleCloneFromSubmenu(containerName, showMainMenu)
      return
    case 'copy':
      await handleCopyConnectionString(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
      return
    case 'backup':
      await handleBackupForContainer(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
      return
    case 'restore':
      await handleRestoreForContainer(containerName, activeDatabase)
      await showContainerSubmenu(containerName, showMainMenu, activeDatabase)
      return
    case 'detach':
      await handleDetachContainer(containerName, showMainMenu)
      return // Return to list after detach
    case 'delete':
      await handleDelete(containerName)
      return // Don't show submenu again after delete
    case 'export':
      await handleExportSubmenu(containerName, databases, showMainMenu)
      return
    case 'back':
      await handleList(showMainMenu)
      return
    case 'main':
      return // Return to main menu
  }
}

export async function handleStart(): Promise<void> {
  const containers = await containerManager.list()
  // Filter for stopped containers, excluding file-based DBs (no server process to start)
  const stopped = containers.filter(
    (c) => c.status !== 'running' && !isFileBasedEngine(c.engine),
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

  // Reuse handleStartContainer for consistent port conflict handling
  await handleStartContainer(containerName)
}

export async function handleStop(): Promise<void> {
  const containers = await containerManager.list()
  // Filter for running containers, excluding file-based DBs (no server process to stop)
  const running = containers.filter(
    (c) => c.status === 'running' && !isFileBasedEngine(c.engine),
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

type StartResult = 'started' | 'back' | 'home'

async function handleStartContainer(
  containerName: string,
): Promise<StartResult> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
    return 'back'
  }

  const portAvailable = await portManager.isPortAvailable(config.port)
  if (!portAvailable) {
    // Find next available port
    let newPort: number
    try {
      const result = await portManager.findAvailablePort({
        preferredPort: config.port,
      })
      newPort = result.port
    } catch {
      console.log()
      console.log(
        uiError('No available ports found. Free up a port and try again.'),
      )
      return 'back'
    }

    // Check if another SpinDB container is using this port
    const allContainers = await containerManager.list()
    const conflictingContainer = allContainers.find(
      (c) =>
        c.name !== containerName &&
        c.port === config.port &&
        c.status === 'running',
    )

    const conflictReason = conflictingContainer
      ? `in use by "${conflictingContainer.name}"`
      : 'in use by another process'

    console.log()
    console.log(uiWarning(`Port ${config.port} is ${conflictReason}`))
    console.log()

    const { action } = await escapeablePrompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          {
            name: `${chalk.green('▶')} Update to port ${newPort} and start ${chalk.gray('(recommended)')}`,
            value: 'update',
          },
          { name: `${chalk.blue('←')} Go back`, value: 'back' },
          {
            name: `${chalk.blue('⌂')} Back to main menu`,
            value: 'home',
          },
        ],
      },
    ])

    if (action === 'back') {
      return 'back'
    }
    if (action === 'home') {
      return 'home'
    }

    // Update port and continue to start
    config.port = newPort
    await containerManager.updateConfig(containerName, { port: newPort })
    console.log(uiSuccess(`Updated port to ${newPort}`))
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
    return 'started'
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
    return 'back'
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
  const isDuckDB = config.engine === Engine.DuckDB
  const isFileBasedDB = isSQLite || isDuckDB

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

  // File-based DBs: show relocate option with file path; others: show port
  if (isFileBasedDB) {
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
    name: `${chalk.blue('⌂')} Back to main menu ${chalk.gray('(esc)')}`,
    value: 'main',
  })

  const { field } = await escapeablePrompt<{ field: string }>([
    {
      type: 'list',
      name: 'field',
      message: 'Select field to edit:',
      choices: editChoices,
      pageSize: getPageSize(),
    },
  ])

  if (field === 'back') {
    return containerName
  }

  if (field === 'main') {
    return null // Signal to go back to main menu
  }

  if (field === 'name') {
    const { newName } = await escapeablePrompt<{ newName: string }>([
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
    const { newPort } = await escapeablePrompt<{ newPort: number }>([
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

    const { inputPath } = await escapeablePrompt<{ inputPath: string }>([
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
    const hasDbExtension = /\.(sqlite3?|db|duckdb|ddb)$/i.test(expandedPath)

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
      const { createDir } = await escapeablePrompt<{ createDir: string }>([
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

      // Update the container config and registry
      await containerManager.updateConfig(containerName, {
        database: finalPath,
      })
      // Use appropriate registry based on engine
      if (isSQLite) {
        await sqliteRegistry.update(containerName, { filePath: finalPath })
      } else if (isDuckDB) {
        await duckdbRegistry.update(containerName, { filePath: finalPath })
      }
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

type SelectDatabaseResult =
  | { action: 'select'; database: string }
  | { action: 'change-default' }
  | { action: 'back' }
  | { action: 'home' }

async function handleSelectDatabase(
  containerName: string,
  databases: string[],
  primaryDatabase: string,
): Promise<SelectDatabaseResult> {
  console.clear()
  console.log(header(`${containerName} - Select Database`))
  console.log()

  const choices: MenuChoice[] = databases.map((db) => ({
    name: db === primaryDatabase ? `${db} ${chalk.gray('(default)')}` : db,
    value: db,
  }))

  choices.push(new inquirer.Separator())
  choices.push({
    name: `${chalk.yellow('★')} Change default database`,
    value: '_change-default',
  })
  choices.push({
    name: `${chalk.blue('←')} Back`,
    value: '_back',
  })
  choices.push({
    name: `${chalk.blue('⌂')} Home ${chalk.gray('(esc)')}`,
    value: '_home',
  })

  const { database } = await escapeablePrompt<{ database: string }>([
    {
      type: 'list',
      name: 'database',
      message: 'Select a database:',
      choices,
      pageSize: getPageSize(),
    },
  ])

  if (database === '_back') {
    return { action: 'back' }
  }
  if (database === '_home') {
    return { action: 'home' }
  }
  if (database === '_change-default') {
    return { action: 'change-default' }
  }

  return { action: 'select', database }
}

async function handleChangeDefaultDatabase(
  containerName: string,
  databases: string[],
  currentDefault: string,
): Promise<void> {
  console.clear()
  console.log(header(`${containerName} - Change Default Database`))
  console.log()

  const choices: MenuChoice[] = databases.map((db) => ({
    name:
      db === currentDefault ? `${db} ${chalk.gray('(current default)')}` : db,
    value: db,
  }))

  choices.push(new inquirer.Separator())
  choices.push({
    name: `${chalk.blue('←')} Cancel`,
    value: '_cancel',
  })

  const { database } = await escapeablePrompt<{ database: string }>([
    {
      type: 'list',
      name: 'database',
      message: 'Select new default database:',
      choices,
      pageSize: getPageSize(),
    },
  ])

  if (database === '_cancel' || database === currentDefault) {
    return
  }

  // Update the container config
  await containerManager.updateConfig(containerName, { database })
  console.log()
  console.log(uiSuccess(`Default database changed to "${database}"`))
  await pressEnterToContinue()
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

  const { targetName } = await escapeablePrompt<{ targetName: string }>([
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
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`Container "${containerName}" not found`))
    await pressEnterToContinue()
    return
  }

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

  let filePath: string | undefined
  // Use appropriate registry based on engine
  if (config.engine === Engine.SQLite) {
    const entry = await sqliteRegistry.get(containerName)
    filePath = entry?.filePath
    await sqliteRegistry.remove(containerName)
  } else if (config.engine === Engine.DuckDB) {
    const entry = await duckdbRegistry.get(containerName)
    filePath = entry?.filePath
    await duckdbRegistry.remove(containerName)
  }

  console.log(uiSuccess(`Detached "${containerName}" from SpinDB`))
  if (filePath) {
    console.log(chalk.gray(`  File remains at: ${filePath}`))
    console.log()
    console.log(chalk.gray('  Re-attach with:'))
    console.log(chalk.cyan(`    spindb attach ${filePath}`))
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

async function handleExportSubmenu(
  containerName: string,
  databases: string[],
  showMainMenu: () => Promise<void>,
): Promise<void> {
  console.log()
  console.log(header('Export'))
  console.log()

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'Export format:',
      choices: [
        { name: `${chalk.cyan('▣')} Docker`, value: 'docker' },
        new inquirer.Separator(),
        { name: `${chalk.blue('←')} Back`, value: 'back' },
        { name: `${chalk.blue('⌂')} Home`, value: 'home' },
      ],
    },
  ])

  switch (action) {
    case 'docker':
      await handleExportDocker(containerName, databases, showMainMenu)
      return
    case 'back':
      await showContainerSubmenu(containerName, showMainMenu, undefined)
      return
    case 'home':
      await showMainMenu()
      return
  }
}

async function handleExportDocker(
  containerName: string,
  databases: string[],
  showMainMenu: () => Promise<void>,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`Container "${containerName}" not found`))
    await pressEnterToContinue()
    await showContainerSubmenu(containerName, showMainMenu, undefined)
    return
  }

  const engine = getEngine(config.engine)
  const engineDefaultPort = getEngineDefaults(config.engine).defaultPort

  // Determine output directory
  const outputDir = join(
    paths.getContainerPath(containerName, { engine: config.engine }),
    'docker',
  )

  // Check if output directory already exists
  if (existsSync(outputDir)) {
    console.log()
    console.log(uiWarning(`Output directory already exists: ${outputDir}`))
    const shouldOverwrite = await promptConfirm(
      'Do you want to overwrite it?',
      false,
    )
    if (!shouldOverwrite) {
      console.log(uiInfo('Export cancelled'))
      await pressEnterToContinue()
      await showContainerSubmenu(containerName, showMainMenu, undefined)
      return
    }
    // Remove existing directory
    await rm(outputDir, { recursive: true, force: true })
  }

  // Determine target port
  let targetPort = engineDefaultPort
  if (config.port !== engineDefaultPort) {
    console.log()
    console.log(
      chalk.yellow(
        `Local container uses port ${chalk.cyan(String(config.port))}, but ${engine.displayName}'s standard port is ${chalk.cyan(String(engineDefaultPort))}.`,
      ),
    )
    const { selectedPort } = await escapeablePrompt<{ selectedPort: number }>([
      {
        type: 'list',
        name: 'selectedPort',
        message: 'Which port should the Docker container use?',
        choices: [
          {
            name: `${engineDefaultPort} ${chalk.gray('(standard port - recommended)')}`,
            value: engineDefaultPort,
          },
          {
            name: `${config.port} ${chalk.gray('(same as local container)')}`,
            value: config.port,
          },
        ],
        default: engineDefaultPort,
      },
    ])
    targetPort = selectedPort
  }

  console.log()
  console.log(chalk.bold(`Exporting ${chalk.cyan(containerName)} to Docker...`))
  console.log()

  // Create backups for all databases
  const backupPaths: Array<{ database: string; path: string }> = []
  const isFileBased = isFileBasedEngine(config.engine)

  if (!isFileBased) {
    const backupSpinner = createSpinner(
      databases.length > 1
        ? `Creating backups for ${databases.length} databases...`
        : 'Creating database backup...',
    )
    backupSpinner.start()

    try {
      await mkdir(join(outputDir, 'data'), { recursive: true })

      for (const db of databases) {
        const backupPath = getExportBackupPath(
          outputDir,
          containerName,
          db,
          config.engine,
        )
        const format = getDefaultFormat(config.engine)
        const result = await engine.backup(config, backupPath, {
          database: db,
          format,
        })
        backupPaths.push({ database: db, path: result.path })
      }

      const totalSize = await Promise.all(
        backupPaths.map(async (bp) => (await stat(bp.path)).size),
      ).then((sizes) => sizes.reduce((a, b) => a + b, 0))

      backupSpinner.succeed(
        databases.length > 1
          ? `Backups created for ${databases.length} databases (${formatBytes(totalSize)})`
          : `Backup created (${formatBytes(totalSize)})`,
      )
    } catch (error) {
      backupSpinner.fail('Backup failed')
      console.log(uiError((error as Error).message))
      await pressEnterToContinue()
      await showContainerSubmenu(containerName, showMainMenu, undefined)
      return
    }
  }

  // Generate Docker artifacts
  const exportSpinner = createSpinner('Generating Docker artifacts...')
  exportSpinner.start()

  try {
    const result = await exportToDocker(config, {
      outputDir,
      port: targetPort,
      includeData: !isFileBased,
      backupPaths: backupPaths.length > 0 ? backupPaths : undefined,
      skipTLS: false,
    })

    exportSpinner.succeed('Docker artifacts generated')

    console.log()
    console.log(uiSuccess(`Exported ${chalk.cyan(containerName)} to Docker`))
    console.log()

    // Display summary
    const lines = [
      `${chalk.bold(engine.displayName)} ${config.version}`,
      `Port: ${chalk.green(String(targetPort))}`,
      databases.length > 1
        ? `Databases: ${chalk.cyan(databases.join(', '))}`
        : `Database: ${chalk.cyan(config.database)}`,
      '',
      chalk.bold('Generated Credentials'),
      chalk.gray('────────────────────────'),
      `Username: ${chalk.white(result.credentials.username)}`,
      `Password: ${chalk.white(result.credentials.password)}`,
      chalk.gray('────────────────────────'),
      '',
      chalk.yellow('Save these credentials now - stored in .env'),
    ]

    // Simple box display using the theme's box function
    console.log(box(lines))

    console.log()
    console.log(chalk.gray('  Output:'), chalk.cyan(result.outputDir))
    console.log()
    console.log(chalk.bold('  To run:'))
    console.log(
      chalk.cyan(`    cd "${result.outputDir}" && docker-compose up -d`),
    )
    console.log()
  } catch (error) {
    exportSpinner.fail('Export failed')
    console.log(uiError((error as Error).message))
  }

  await pressEnterToContinue()
  await showContainerSubmenu(containerName, showMainMenu, undefined)
}
