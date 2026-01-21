import chalk from 'chalk'
import inquirer from 'inquirer'
import { existsSync } from 'fs'
import { rm, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { containerManager } from '../../../core/container-manager'
import { getMissingDependencies } from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { portManager } from '../../../core/port-manager'
import { getEngine } from '../../../engines'
import { defaults } from '../../../config/defaults'
import {
  getBackupExtension,
  getBackupSpinnerLabel,
  getDefaultFormat,
} from '../../../config/backup-formats'
import {
  generateBackupTimestamp,
  estimateBackupSize,
  checkBackupSize,
} from '../../../core/backup-restore'
import {
  promptCreateOptions,
  promptContainerName,
  promptContainerSelect,
  promptDatabaseName,
  promptDatabaseSelect,
  promptBackupFormat,
  promptBackupFilename,
  promptBackupDirectory,
  promptInstallDependencies,
  promptConfirm,
} from '../../ui/prompts'
import { createSpinner } from '../../ui/spinner'
import {
  header,
  uiSuccess,
  uiError,
  uiWarning,
  connectionBox,
  formatBytes,
} from '../../ui/theme'
import { getEngineIcon } from '../../constants'
import { type Engine } from '../../../types'
import { pressEnterToContinue } from './shared'
import { SpinDBError, ErrorCodes } from '../../../core/error-handler'

// Strip surrounding quotes from paths (handles drag-and-drop paths)
function stripQuotes(path: string): string {
  return path.replace(/^['"]|['"]$/g, '').trim()
}

/**
 * Mask the password portion of a connection string for display.
 * Example: postgresql://user:secretpass@host:5432/db → postgresql://user:****@host:5432/db
 */
function maskConnectionStringPassword(connectionString: string): string {
  if (!connectionString) return connectionString
  try {
    // Match pattern: scheme://[user[:password]@]host
    // This regex captures: scheme://user: then password, then @host...
    return connectionString.replace(
      /^([a-z+]+:\/\/[^:]*:)([^@]+)(@.*)$/i,
      (_, prefix, _password, suffix) => `${prefix}****${suffix}`,
    )
  } catch {
    return connectionString
  }
}

export async function handleCreateForRestore(): Promise<{
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

  const portAvailable = await portManager.isPortAvailable(port)
  if (!portAvailable) {
    console.log(
      uiError(`Port ${port} is in use. Please choose a different port.`),
    )
    return null
  }

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

  const startSpinner = createSpinner(`Starting ${dbEngine.displayName}...`)
  startSpinner.start()

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    startSpinner.fail('Failed to get container config')
    return null
  }

  await dbEngine.start(config)
  await containerManager.updateConfig(containerName, { status: 'running' })

  startSpinner.succeed(`${dbEngine.displayName} started`)

  if (database !== 'postgres') {
    const dbSpinner = createSpinner(`Creating database "${database}"...`)
    dbSpinner.start()

    await dbEngine.createDatabase(config, database)

    dbSpinner.succeed(`Database "${database}" created`)
  }

  console.log()
  console.log(uiSuccess('Container ready for restore'))
  console.log()

  return { name: containerName, config }
}

export async function handleRestore(): Promise<void> {
  // Use a loop instead of recursion for "back" navigation
  while (true) {
    const containers = await containerManager.list()
    const running = containers.filter((c) => c.status === 'running')

    const choices = [
      ...running.map((c) => ({
        name: `${c.name} ${chalk.gray(`(${getEngineIcon(c.engine)} ${c.engine} ${c.version}, port ${c.port})`)} ${chalk.green('● running')}`,
        value: c.name,
        short: c.name,
      })),
      new inquirer.Separator(),
      {
        name: `${chalk.green('➕')} Create new container`,
        value: '__create_new__',
        short: 'Create new',
      },
      new inquirer.Separator(),
      {
        name: `${chalk.blue('←')} Back`,
        value: '__back__',
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

    if (selectedContainer === '__back__') {
      return
    }

    let containerName: string
    let config: Awaited<ReturnType<typeof containerManager.getConfig>>

    if (selectedContainer === '__create_new__') {
      const createResult = await handleCreateForRestore()
      if (!createResult) return
      containerName = createResult.name
      config = createResult.config
    } else {
      containerName = selectedContainer
      config = await containerManager.getConfig(containerName)
      if (!config) {
        console.error(uiError(`Container "${containerName}" not found`))
        return
      }
    }

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
          uiError(
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

    // All engines now support dumpFromConnectionString
    const restoreChoices: Array<{ name: string; value: string } | inquirer.Separator> = [
      {
        name: `${chalk.magenta('📁')} Dump file (drag and drop or enter path)`,
        value: 'file',
      },
    ]

    restoreChoices.push({
      name: `${chalk.cyan('🔗')} Connection string (pull from remote database)`,
      value: 'connection',
    })

    restoreChoices.push(
      new inquirer.Separator(),
      {
        name: `${chalk.blue('←')} Back`,
        value: '__back__',
      },
    )

    const { restoreSource } = await inquirer.prompt<{
      restoreSource: 'file' | 'connection' | '__back__'
    }>([
      {
        type: 'list',
        name: 'restoreSource',
        message: 'Restore from:',
        choices: restoreChoices,
      },
    ])

    if (restoreSource === '__back__') {
      continue // Go back to container selection
    }

    let backupPath = ''
    let isTempFile = false

    if (restoreSource === 'connection') {
      console.log(
        chalk.gray('  Enter connection string, or press Enter to go back'),
      )
      const { connectionString } = await inquirer.prompt<{
        connectionString: string
      }>([
        {
          type: 'input',
          name: 'connectionString',
          message: 'Connection string:',
          transformer: (input: string) => maskConnectionStringPassword(input),
          validate: (input: string) => {
            if (!input) return true
            switch (config.engine) {
              case 'mysql':
                if (!input.startsWith('mysql://')) {
                  return 'Connection string must start with mysql://'
                }
                break
              case 'mariadb':
                if (!input.startsWith('mysql://') && !input.startsWith('mariadb://')) {
                  return 'Connection string must start with mysql:// or mariadb://'
                }
                break
              case 'mongodb':
                if (!input.startsWith('mongodb://') && !input.startsWith('mongodb+srv://')) {
                  return 'Connection string must start with mongodb:// or mongodb+srv://'
                }
                break
              case 'redis':
              case 'valkey':
                if (!input.startsWith('redis://')) {
                  return 'Connection string must start with redis://'
                }
                break
              case 'clickhouse':
                if (!input.startsWith('clickhouse://') && !input.startsWith('http://') && !input.startsWith('https://')) {
                  return 'Connection string must start with clickhouse://, http://, or https://'
                }
                break
              case 'qdrant':
                if (!input.startsWith('qdrant://') && !input.startsWith('http://') && !input.startsWith('https://')) {
                  return 'Connection string must start with qdrant://, http://, or https://'
                }
                break
              default:
                // PostgreSQL and others
                if (!input.startsWith('postgresql://') && !input.startsWith('postgres://')) {
                  return 'Connection string must start with postgresql:// or postgres://'
                }
            }
            return true
          },
        },
      ])

      if (!connectionString.trim()) {
        continue // Return to container selection
      }

      const engine = getEngine(config.engine)

      const timestamp = Date.now()
      const defaultFormat = getDefaultFormat(config.engine as Engine)
      const dumpExtension = getBackupExtension(config.engine as Engine, defaultFormat)
      const tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}${dumpExtension}`)

      let dumpSuccess = false
      let attempts = 0
      const maxAttempts = 2

      while (!dumpSuccess && attempts < maxAttempts) {
        attempts++
        const dumpSpinner = createSpinner(
          'Creating dump from remote database...',
        )
        dumpSpinner.start()

        try {
          const dumpResult = await engine.dumpFromConnectionString(
            connectionString,
            tempDumpPath,
          )
          dumpSpinner.succeed('Dump created from remote database')
          if (dumpResult.warnings?.length) {
            for (const warning of dumpResult.warnings) {
              console.log(chalk.yellow(`  ${warning}`))
            }
          }
          backupPath = tempDumpPath
          isTempFile = true
          dumpSuccess = true
        } catch (error) {
          const e = error as Error
          dumpSpinner.fail('Failed to create dump')

          // Handle version mismatch errors with helpful message
          if (
            e instanceof SpinDBError &&
            e.code === ErrorCodes.VERSION_MISMATCH
          ) {
            console.log()
            console.log(uiError('PostgreSQL version mismatch:'))
            console.log(chalk.gray(`  ${e.message}`))
            if (e.suggestion) {
              console.log()
              console.log(uiWarning('To fix this:'))
              console.log(chalk.yellow(`  ${e.suggestion}`))
            }
            console.log()

            try {
              await rm(tempDumpPath, { force: true })
            } catch {
              // Ignore cleanup errors
            }

            await pressEnterToContinue()
            return
          }

          // Handle connection errors
          if (
            e instanceof SpinDBError &&
            e.code === ErrorCodes.CONNECTION_FAILED
          ) {
            console.log()
            console.log(uiError('Connection failed:'))
            console.log(chalk.gray(`  ${e.message}`))
            if (e.suggestion) {
              console.log(chalk.yellow(`  ${e.suggestion}`))
            }
            console.log()

            await pressEnterToContinue()
            return
          }

          // Handle missing tool errors
          if (
            e.message.includes('pg_dump not found') ||
            e.message.includes('mysqldump not found') ||
            e.message.includes('ENOENT')
          ) {
            const missingTool = e.message.includes('mysqldump')
              ? 'mysqldump'
              : 'pg_dump'
            const toolEngine =
              missingTool === 'mysqldump' ? 'mysql' : 'postgresql'
            const installed = await promptInstallDependencies(
              missingTool,
              toolEngine as Engine,
            )
            if (installed) {
              // Installation counts toward maxAttempts - retry with newly installed tools
              continue
            }
          } else {
            const dumpTool = config.engine === 'mysql' ? 'mysqldump' : 'pg_dump'
            console.log()
            console.log(uiError(`${dumpTool} error:`))
            console.log(chalk.gray(`  ${e.message}`))
            console.log()
          }

          try {
            await rm(tempDumpPath, { force: true })
          } catch {
            // Ignore cleanup errors
          }

          await pressEnterToContinue()
          return
        }
      }

      if (!dumpSuccess) {
        console.log(uiError('Failed to create dump after retries'))
        return
      }
    } else {
      console.log(
        chalk.gray(
          '  Drag & drop, enter path (abs or rel), or press Enter to go back',
        ),
      )
      const { backupPath: rawBackupPath } = await inquirer.prompt<{
        backupPath: string
      }>([
        {
          type: 'input',
          name: 'backupPath',
          message: 'Backup file path:',
          validate: (input: string) => {
            if (!input) return true
            const cleanPath = stripQuotes(input)
            if (!existsSync(cleanPath)) return 'File not found'
            return true
          },
        },
      ])

      if (!rawBackupPath.trim()) {
        continue // Return to container selection
      }

      backupPath = stripQuotes(rawBackupPath)
    }

    const engine = getEngine(config.engine)

    // Get existing databases in this container
    const existingDatabases = config.databases || [config.database]

    // Redis uses numbered databases 0-15, so "create new" doesn't apply
    const isRedis = config.engine === 'redis'

    // Restore mode selection
    type RestoreMode = 'new' | 'replace' | '__back__'
    let restoreMode: RestoreMode

    if (isRedis) {
      // Redis: Always restore to existing database (0-15)
      restoreMode = 'replace'
    } else {
      const result = await inquirer.prompt<{ restoreMode: RestoreMode }>([
        {
          type: 'list',
          name: 'restoreMode',
          message: 'How would you like to restore?',
          choices: [
            {
              name: `${chalk.green('➕')} Create new database ${chalk.gray('(keeps existing databases intact)')}`,
              value: 'new',
            },
            {
              name: `${chalk.yellow('🔄')} Replace existing database ${chalk.gray('(overwrites data)')}`,
              value: 'replace',
              disabled:
                existingDatabases.length === 0
                  ? 'No existing databases'
                  : false,
            },
            new inquirer.Separator(),
            {
              name: `${chalk.blue('←')} Back`,
              value: '__back__',
            },
          ],
        },
      ])
      restoreMode = result.restoreMode
    }

    if (restoreMode === '__back__') {
      continue // Return to container selection
    }

    let databaseName: string

    if (restoreMode === 'new') {
      // Show existing databases for context
      if (existingDatabases.length > 0) {
        console.log()
        console.log(chalk.gray('  Existing databases in this container:'))
        for (const db of existingDatabases) {
          console.log(chalk.gray(`    • ${db}`))
        }
        console.log()
      }

      // Prompt for new database name (must not already exist)
      const result = await promptDatabaseName(containerName, config.engine, {
        allowBack: true,
        existingDatabases,
        disallowExisting: true,
      })

      if (result === null) {
        continue // Return to container selection
      }
      databaseName = result
    } else {
      // Replace existing database - show selection
      if (existingDatabases.length === 1) {
        databaseName = existingDatabases[0]
      } else {
        const result = await promptDatabaseSelect(
          existingDatabases,
          'Select database to replace:',
          { includeBack: true },
        )
        if (result === null) {
          continue // Return to container selection
        }
        databaseName = result
      }

      // Confirm overwrite
      const confirmed = await promptConfirm(
        `This will overwrite all data in "${databaseName}". Continue?`,
        false,
      )

      if (!confirmed) {
        continue // Return to container selection
      }

      // Redis doesn't need drop/create - databases 0-15 always exist
      if (!isRedis) {
        // Drop the existing database before restore
        console.log()
        const dropSpinner = createSpinner(
          `Dropping existing database "${databaseName}"...`,
        )
        dropSpinner.start()

        try {
          await engine.dropDatabase(config, databaseName)
          dropSpinner.succeed(`Dropped database "${databaseName}"`)
        } catch (error) {
          dropSpinner.fail(`Failed to drop database "${databaseName}"`)
          console.log(uiError((error as Error).message))
          await pressEnterToContinue()
          return
        }
      }
    }

    const detectSpinner = createSpinner('Detecting backup format...')
    detectSpinner.start()

    const format = await engine.detectBackupFormat(backupPath)
    detectSpinner.succeed(`Detected: ${format.description}`)

    // For Redis .redis text files, ask about merge vs replace behavior
    let flushBeforeRestore = false
    if (isRedis && format.format === 'redis') {
      const { restoreBehavior } = await inquirer.prompt<{
        restoreBehavior: 'replace' | 'merge'
      }>([
        {
          type: 'list',
          name: 'restoreBehavior',
          message: 'How should existing data be handled?',
          choices: [
            {
              name: `${chalk.yellow('🔄')} Replace all ${chalk.gray('(FLUSHDB - clear database first)')}`,
              value: 'replace',
            },
            {
              name: `${chalk.green('➕')} Merge ${chalk.gray('(add/update keys, keep others)')}`,
              value: 'merge',
            },
          ],
        },
      ])
      flushBeforeRestore = restoreBehavior === 'replace'
    }

    // Redis doesn't need createDatabase - databases 0-15 always exist
    if (!isRedis) {
      const dbSpinner = createSpinner(`Creating database "${databaseName}"...`)
      dbSpinner.start()

      await engine.createDatabase(config, databaseName)
      dbSpinner.succeed(`Database "${databaseName}" ready`)
    }

    const restoreSpinner = createSpinner('Restoring backup...')
    restoreSpinner.start()

    const result = await engine.restore(config, backupPath, {
      database: databaseName,
      createDatabase: false,
      flush: flushBeforeRestore,
    })

    if (result.code === 0) {
      restoreSpinner.succeed('Backup restored successfully')
    } else {
      const stderr = result.stderr || ''

      if (
        stderr.includes('unsupported version') ||
        stderr.includes('Archive version') ||
        stderr.includes('too old')
      ) {
        restoreSpinner.fail('Version compatibility detected')
        console.log()
        console.log(uiError('PostgreSQL version incompatibility detected:'))
        console.log(
          uiWarning('Your pg_restore version is too old for this backup file.'),
        )

        console.log(chalk.yellow('Cleaning up failed database...'))
        try {
          await engine.dropDatabase(config, databaseName)
          console.log(chalk.gray(`✓ Removed database "${databaseName}"`))
        } catch {
          console.log(
            chalk.yellow(
              `Warning: Could not remove database "${databaseName}"`,
            ),
          )
        }

        console.log()

        const versionMatch = stderr.match(/PostgreSQL (\d+)/)
        const requiredVersion = versionMatch ? versionMatch[1] : '17'

        console.log(
          chalk.gray(
            `This backup was created with PostgreSQL ${requiredVersion}`,
          ),
        )
        console.log()

        console.log()
        console.log(
          uiWarning(
            `To restore this backup, download PostgreSQL ${requiredVersion} binaries:`,
          ),
        )
        console.log(
          chalk.cyan(`  spindb engines download postgresql ${requiredVersion}`),
        )
        console.log()
        console.log(
          chalk.gray(
            'Then create a new container with that version and try the restore again.',
          ),
        )
        await pressEnterToContinue()
        return
      } else {
        // Other restore errors - show warnings
        restoreSpinner.warn('Restore completed with warnings')
        if (result.stderr) {
          console.log()
          console.log(chalk.yellow('  Warnings/Errors:'))
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

    if (result.code === 0) {
      const connectionString = engine.getConnectionString(config, databaseName)
      console.log()
      console.log(uiSuccess(`Database "${databaseName}" restored`))
      console.log(chalk.gray('  Connection string:'))
      console.log(chalk.cyan(`  ${connectionString}`))

      const copied = await platformService.copyToClipboard(connectionString)
      if (copied) {
        console.log(chalk.gray('  ✓ Connection string copied to clipboard'))
      } else {
        console.log(chalk.gray('  (Could not copy to clipboard)'))
      }

      console.log()
    }

    if (isTempFile) {
      try {
        await rm(backupPath, { force: true })
      } catch {
        // Ignore cleanup errors
      }
    }

    await pressEnterToContinue()

    return // Exit the wizard loop after successful restore
  }
}

/**
 * Shared backup flow for both main menu and container submenu
 * Reduces code duplication between handleBackup and handleBackupForContainer
 */
async function performBackupFlow(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)

  // Check dependencies
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
        uiError(
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

  // Select database (auto-select if only one)
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

  // Show estimated size
  const estimatedSize = await estimateBackupSize(config)
  if (estimatedSize !== null) {
    console.log(
      chalk.gray(`  Estimated database size: ${formatBytes(estimatedSize)}`),
    )
    console.log()
  }

  // Select format
  const format = await promptBackupFormat(config.engine)

  // Select output directory
  const outputDir = await promptBackupDirectory()
  if (!outputDir) return

  // Ensure directory exists
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // Get filename
  const defaultFilename = `${containerName}-${databaseName}-backup-${generateBackupTimestamp()}`
  const filename = await promptBackupFilename(defaultFilename)

  const extension = getBackupExtension(config.engine, format)
  const outputPath = join(outputDir, `${filename}${extension}`)

  const spinnerLabel = getBackupSpinnerLabel(config.engine, format)
  const backupSpinner = createSpinner(
    `Creating ${spinnerLabel} backup of "${databaseName}"...`,
  )
  backupSpinner.start()

  try {
    const result = await engine.backup(config, outputPath, {
      database: databaseName,
      format,
    })

    backupSpinner.succeed('Backup created successfully')

    console.log()
    console.log(uiSuccess('Backup complete'))
    console.log()
    console.log(chalk.gray('  Saved to:'), chalk.cyan(result.path))
    console.log(chalk.gray('  Size:'), chalk.white(formatBytes(result.size)))
    console.log(chalk.gray('  Format:'), chalk.white(result.format))
    console.log()
  } catch (error) {
    const e = error as Error
    backupSpinner.fail('Backup failed')
    console.log()
    console.log(uiError(e.message))
    console.log()
  }
}

export async function handleBackup(): Promise<void> {
  const containers = await containerManager.list()
  const running = containers.filter((c) => c.status === 'running')

  if (running.length === 0) {
    console.log(uiWarning('No running containers. Start a container first.'))
    await pressEnterToContinue()
    return
  }

  const containerName = await promptContainerSelect(
    running,
    'Select container to backup:',
    { includeBack: true },
  )
  if (!containerName) return

  await performBackupFlow(containerName)
  await pressEnterToContinue()
}

/**
 * Handle backup for a specific container (used from container submenu)
 * Skips container selection since we already know which container
 */
export async function handleBackupForContainer(
  containerName: string,
): Promise<void> {
  await performBackupFlow(containerName)
  await pressEnterToContinue()
}

/**
 * Handle restore for a specific container (used from container submenu)
 * Skips container selection since we already know which container
 */
export async function handleRestoreForContainer(
  containerName: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(uiError(`Container "${containerName}" not found`))
    await pressEnterToContinue()
    return
  }

  const engine = getEngine(config.engine)

  // Check dependencies
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
        uiError(
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

  // Restore source selection (file or connection string)
  // All engines now support dumpFromConnectionString
  const restoreChoices: Array<{ name: string; value: string } | inquirer.Separator> = [
    {
      name: `${chalk.magenta('📁')} Dump file (drag and drop or enter path)`,
      value: 'file',
    },
    {
      name: `${chalk.cyan('🔗')} Connection string (pull from remote database)`,
      value: 'connection',
    },
  ]

  restoreChoices.push(
    new inquirer.Separator(),
    {
      name: `${chalk.blue('←')} Back`,
      value: '__back__',
    },
  )

  const { restoreSource } = await inquirer.prompt<{
    restoreSource: 'file' | 'connection' | '__back__'
  }>([
    {
      type: 'list',
      name: 'restoreSource',
      message: 'Restore from:',
      choices: restoreChoices,
    },
  ])

  if (restoreSource === '__back__') {
    return
  }

  let backupPath = ''
  let isTempFile = false

  if (restoreSource === 'connection') {
    // Handle connection string restore
    console.log(
      chalk.gray('  Enter connection string, or press Enter to go back'),
    )
    const { connectionString } = await inquirer.prompt<{
      connectionString: string
    }>([
      {
        type: 'input',
        name: 'connectionString',
        message: 'Connection string:',
        transformer: (input: string) => maskConnectionStringPassword(input),
        validate: (input: string) => {
          if (!input) return true
          switch (config.engine) {
            case 'mysql':
              if (!input.startsWith('mysql://')) {
                return 'Connection string must start with mysql://'
              }
              break
            case 'mariadb':
              if (!input.startsWith('mysql://') && !input.startsWith('mariadb://')) {
                return 'Connection string must start with mysql:// or mariadb://'
              }
              break
            case 'mongodb':
              if (!input.startsWith('mongodb://') && !input.startsWith('mongodb+srv://')) {
                return 'Connection string must start with mongodb:// or mongodb+srv://'
              }
              break
            case 'redis':
            case 'valkey':
              if (!input.startsWith('redis://')) {
                return 'Connection string must start with redis://'
              }
              break
            case 'clickhouse':
              if (!input.startsWith('clickhouse://') && !input.startsWith('http://') && !input.startsWith('https://')) {
                return 'Connection string must start with clickhouse://, http://, or https://'
              }
              break
            case 'qdrant':
              if (!input.startsWith('qdrant://') && !input.startsWith('http://') && !input.startsWith('https://')) {
                return 'Connection string must start with qdrant://, http://, or https://'
              }
              break
            default:
              // PostgreSQL and others
              if (!input.startsWith('postgresql://') && !input.startsWith('postgres://')) {
                return 'Connection string must start with postgresql:// or postgres://'
              }
          }
          return true
        },
      },
    ])

    if (!connectionString.trim()) {
      return
    }

    const timestamp = Date.now()
    const defaultFormat = getDefaultFormat(config.engine as Engine)
    const dumpExtension = getBackupExtension(config.engine as Engine, defaultFormat)
    const tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}${dumpExtension}`)

    const dumpSpinner = createSpinner('Creating dump from remote database...')
    dumpSpinner.start()

    try {
      const dumpResult = await engine.dumpFromConnectionString(
        connectionString,
        tempDumpPath,
      )
      dumpSpinner.succeed('Dump created from remote database')
      if (dumpResult.warnings?.length) {
        for (const warning of dumpResult.warnings) {
          console.log(chalk.yellow(`  ${warning}`))
        }
      }
      backupPath = tempDumpPath
      isTempFile = true
    } catch (error) {
      const e = error as Error
      dumpSpinner.fail('Failed to create dump')
      console.log(uiError(e.message))
      await pressEnterToContinue()
      return
    }
  } else {
    // Handle file restore
    console.log(
      chalk.gray(
        '  Drag and drop the backup file here, or type the path (press Enter to cancel)',
      ),
    )
    const { backupPath: rawBackupPath } = await inquirer.prompt<{
      backupPath: string
    }>([
      {
        type: 'input',
        name: 'backupPath',
        message: 'Backup file path:',
        validate: (input: string) => {
          if (!input) return true
          const cleanPath = stripQuotes(input)
          if (!existsSync(cleanPath)) return 'File not found'
          return true
        },
      },
    ])

    if (!rawBackupPath.trim()) {
      return
    }

    backupPath = stripQuotes(rawBackupPath)
  }

  // Check backup file size and warn if large
  const sizeCheck = checkBackupSize(backupPath)
  if (sizeCheck.level === 'very_large') {
    console.log()
    console.log(
      chalk.yellow(`  ⚠ Large backup file: ${formatBytes(sizeCheck.size)}`),
    )
    console.log(chalk.gray('  This restore may take a while.'))
    console.log()
    const confirmed = await promptConfirm('Continue with restore?', true)
    if (!confirmed) {
      if (isTempFile) {
        await rm(backupPath, { force: true }).catch(() => {})
      }
      return
    }
  } else if (sizeCheck.level === 'large') {
    console.log(
      chalk.gray(`  Backup file size: ${formatBytes(sizeCheck.size)}`),
    )
  }

  // Detect backup format
  const format = await engine.detectBackupFormat(backupPath)
  console.log(chalk.gray(`  Detected format: ${format.description}`))
  console.log()

  // Get existing databases in this container
  const existingDatabases = config.databases || [config.database]

  // Redis uses numbered databases 0-15, so "create new" doesn't apply
  const isRedis = config.engine === 'redis'

  // Restore mode selection
  type RestoreMode = 'new' | 'replace' | '__back__'
  let restoreMode: RestoreMode

  if (isRedis) {
    // Redis: Always restore to existing database (0-15)
    restoreMode = 'replace'
  } else {
    const result = await inquirer.prompt<{ restoreMode: RestoreMode }>([
      {
        type: 'list',
        name: 'restoreMode',
        message: 'How would you like to restore?',
        choices: [
          {
            name: `${chalk.green('➕')} Create new database ${chalk.gray('(keeps existing databases intact)')}`,
            value: 'new',
          },
          {
            name: `${chalk.yellow('🔄')} Replace existing database ${chalk.gray('(overwrites data)')}`,
            value: 'replace',
            disabled:
              existingDatabases.length === 0 ? 'No existing databases' : false,
          },
          new inquirer.Separator(),
          {
            name: `${chalk.blue('←')} Back`,
            value: '__back__',
          },
        ],
      },
    ])
    restoreMode = result.restoreMode
  }

  if (restoreMode === '__back__') {
    if (isTempFile) {
      await rm(backupPath, { force: true }).catch(() => {})
    }
    return
  }

  let databaseName: string

  if (restoreMode === 'new') {
    // Show existing databases for context
    if (existingDatabases.length > 0) {
      console.log()
      console.log(chalk.gray('  Existing databases in this container:'))
      for (const db of existingDatabases) {
        console.log(chalk.gray(`    • ${db}`))
      }
      console.log()
    }

    // Prompt for new database name
    const result = await promptDatabaseName(containerName, config.engine, {
      existingDatabases,
    })
    if (!result) {
      if (isTempFile) {
        await rm(backupPath, { force: true }).catch(() => {})
      }
      return
    }
    databaseName = result

    // Create the new database
    const createDbSpinner = createSpinner(
      `Creating database "${databaseName}"...`,
    )
    createDbSpinner.start()
    try {
      await engine.createDatabase(config, databaseName)
      createDbSpinner.succeed(`Database "${databaseName}" created`)

      // Update container config with new database
      const updatedDbs = [...existingDatabases, databaseName]
      await containerManager.updateConfig(containerName, {
        databases: updatedDbs,
      })
    } catch (error) {
      const e = error as Error
      createDbSpinner.fail('Failed to create database')
      console.log(uiError(e.message))
      if (isTempFile) {
        await rm(backupPath, { force: true }).catch(() => {})
      }
      await pressEnterToContinue()
      return
    }
  } else {
    // Replace existing database - auto-select if only one
    if (existingDatabases.length === 1) {
      databaseName = existingDatabases[0]
      console.log(chalk.gray(`  Using database: ${databaseName}`))
    } else {
      const { database } = await inquirer.prompt<{ database: string }>([
        {
          type: 'list',
          name: 'database',
          message: 'Select database to replace:',
          choices: existingDatabases.map((db) => ({ name: db, value: db })),
        },
      ])
      databaseName = database
    }
  }

  // For Redis .redis text files, ask about merge vs replace behavior
  let flushBeforeRestore = false
  if (isRedis && format.format === 'redis') {
    const { restoreBehavior } = await inquirer.prompt<{
      restoreBehavior: 'replace' | 'merge'
    }>([
      {
        type: 'list',
        name: 'restoreBehavior',
        message: 'How should existing data be handled?',
        choices: [
          {
            name: `${chalk.yellow('🔄')} Replace all ${chalk.gray('(FLUSHDB - clear database first)')}`,
            value: 'replace',
          },
          {
            name: `${chalk.green('➕')} Merge ${chalk.gray('(add/update keys, keep others)')}`,
            value: 'merge',
          },
        ],
      },
    ])
    flushBeforeRestore = restoreBehavior === 'replace'
  }

  // Perform restore
  const restoreSpinner = createSpinner(
    `Restoring to "${databaseName}" in ${containerName}...`,
  )
  restoreSpinner.start()

  try {
    const result = await engine.restore(config, backupPath, {
      database: databaseName,
      flush: flushBeforeRestore,
    })

    if (result.code === 0) {
      restoreSpinner.succeed('Restore completed successfully')

      const connectionString = engine.getConnectionString(config, databaseName)
      console.log()
      console.log(uiSuccess(`Database "${databaseName}" restored`))
      console.log(chalk.gray('  Connection string:'))
      console.log(chalk.cyan(`  ${connectionString}`))

      const copied = await platformService.copyToClipboard(connectionString)
      if (copied) {
        console.log(chalk.gray('  ✓ Connection string copied to clipboard'))
      }
      console.log()
    } else {
      restoreSpinner.warn('Restore completed with warnings')
      if (result.stderr) {
        console.log()
        console.log(chalk.yellow('  Warnings/Errors:'))
        const lines = result.stderr.split('\n').filter((l) => l.trim())
        const displayLines = lines.slice(0, 10)
        for (const line of displayLines) {
          console.log(chalk.gray(`  ${line}`))
        }
        if (lines.length > 10) {
          console.log(chalk.gray(`  ... and ${lines.length - 10} more lines`))
        }
      }
    }
  } catch (error) {
    const e = error as Error
    restoreSpinner.fail('Restore failed')
    console.log()
    console.log(uiError(e.message))
    console.log()
  }

  await pressEnterToContinue()
}

export async function handleClone(): Promise<void> {
  const containers = await containerManager.list()
  const stopped = containers.filter((c) => c.status !== 'running')

  if (containers.length === 0) {
    console.log(uiWarning('No containers found'))
    return
  }

  if (stopped.length === 0) {
    console.log(
      uiWarning(
        'All containers are running. Stop a container first to clone it.',
      ),
    )
    return
  }

  const sourceName = await promptContainerSelect(
    stopped,
    'Select container to clone:',
    { includeBack: true },
  )
  if (!sourceName) return

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
  } catch (error) {
    const e = error as Error
    spinner.fail(`Failed to clone "${sourceName}"`)
    console.log(uiError(e.message))
  }
}
