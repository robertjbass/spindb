import chalk from 'chalk'
import inquirer from 'inquirer'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { containerManager } from '../../../core/container-manager'
import { getMissingDependencies } from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { portManager } from '../../../core/port-manager'
import { getEngine } from '../../../engines'
import { defaults } from '../../../config/defaults'
import { getPostgresHomebrewPackage } from '../../../config/engine-defaults'
import { updatePostgresClientTools } from '../../../engines/postgresql/binary-manager'
import {
  promptCreateOptions,
  promptContainerName,
  promptContainerSelect,
  promptDatabaseName,
  promptDatabaseSelect,
  promptBackupFormat,
  promptBackupFilename,
  promptInstallDependencies,
} from '../../ui/prompts'
import { createSpinner } from '../../ui/spinner'
import {
  header,
  success,
  error,
  warning,
  connectionBox,
  formatBytes,
} from '../../ui/theme'
import { getEngineIcon } from '../../constants'
import { type Engine } from '../../../types'

function generateBackupTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/:/g, '').split('.')[0]
}

function getBackupExtension(format: 'sql' | 'dump', engine: string): string {
  if (format === 'sql') {
    return '.sql'
  }
  // MySQL dump is gzipped SQL, PostgreSQL dump is custom format
  return engine === 'mysql' ? '.sql.gz' : '.dump'
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
      error(`Port ${port} is in use. Please choose a different port.`),
    )
    return null
  }

  const binarySpinner = createSpinner(
    `Checking ${dbEngine.displayName} ${version} binaries...`,
  )
  binarySpinner.start()

  const isInstalled = await dbEngine.isBinaryInstalled(version)
  if (isInstalled) {
    binarySpinner.succeed(`${dbEngine.displayName} ${version} binaries ready (cached)`)
  } else {
    binarySpinner.text = `Downloading ${dbEngine.displayName} ${version} binaries...`
    await dbEngine.ensureBinaries(version, ({ message }) => {
      binarySpinner.text = message
    })
    binarySpinner.succeed(`${dbEngine.displayName} ${version} binaries downloaded`)
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
  console.log(success('Container ready for restore'))
  console.log()

  return { name: containerName, config }
}

export async function handleRestore(): Promise<void> {
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
    const createResult = await handleCreateForRestore()
    if (!createResult) return
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
        validate: (input: string) => {
          if (!input) return true
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

    if (!connectionString.trim()) {
      return
    }

    const engine = getEngine(config.engine)

    const timestamp = Date.now()
    const tempDumpPath = join(tmpdir(), `spindb-dump-${timestamp}.dump`)

    let dumpSuccess = false
    let attempts = 0
    const maxAttempts = 2

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

        if (
          e.message.includes('pg_dump not found') ||
          e.message.includes('mysqldump not found') ||
          e.message.includes('ENOENT')
        ) {
          const missingTool = e.message.includes('mysqldump')
            ? 'mysqldump'
            : 'pg_dump'
          const toolEngine = missingTool === 'mysqldump' ? 'mysql' : 'postgresql'
          const installed = await promptInstallDependencies(missingTool, toolEngine as Engine)
          if (installed) {
            continue
          }
        } else {
          const dumpTool = config.engine === 'mysql' ? 'mysqldump' : 'pg_dump'
          console.log()
          console.log(error(`${dumpTool} error:`))
          console.log(chalk.gray(`  ${e.message}`))
          console.log()
        }

        try {
          await rm(tempDumpPath, { force: true })
        } catch {
          // Ignore cleanup errors
        }

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

    if (!dumpSuccess) {
      console.log(error('Failed to create dump after retries'))
      return
    }
  } else {
    const stripQuotes = (path: string) =>
      path.replace(/^['"]|['"]$/g, '').trim()

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
      return
    }

    backupPath = stripQuotes(rawBackupPath)
  }

  const databaseName = await promptDatabaseName(containerName, config.engine)

  const engine = getEngine(config.engine)

  const detectSpinner = createSpinner('Detecting backup format...')
  detectSpinner.start()

  const format = await engine.detectBackupFormat(backupPath)
  detectSpinner.succeed(`Detected: ${format.description}`)

  const dbSpinner = createSpinner(`Creating database "${databaseName}"...`)
  dbSpinner.start()

  await engine.createDatabase(config, databaseName)
  dbSpinner.succeed(`Database "${databaseName}" ready`)

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

      const versionMatch = stderr.match(/PostgreSQL (\d+)/)
      const requiredVersion = versionMatch ? versionMatch[1] : '17'

      console.log(
        chalk.gray(
          `This backup was created with PostgreSQL ${requiredVersion}`,
        ),
      )
      console.log()

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

  if (result.code === 0 || !result.stderr) {
    const connectionString = engine.getConnectionString(config, databaseName)
    console.log()
    console.log(success(`Database "${databaseName}" restored`))
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

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to continue...'),
    },
  ])
}

export async function handleBackup(): Promise<void> {
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

  const containerName = await promptContainerSelect(
    running,
    'Select container to backup:',
    { includeBack: true },
  )
  if (!containerName) return

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.log(error(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)

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

  const format = await promptBackupFormat(config.engine)

  const defaultFilename = `${containerName}-${databaseName}-backup-${generateBackupTimestamp()}`
  const filename = await promptBackupFilename(defaultFilename)

  const extension = getBackupExtension(format, config.engine)
  const outputPath = join(process.cwd(), `${filename}${extension}`)

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

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to continue...'),
    },
  ])
}

export async function handleClone(): Promise<void> {
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
    { includeBack: true },
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
