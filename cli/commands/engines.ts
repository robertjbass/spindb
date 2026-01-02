import { Command } from 'commander'
import chalk from 'chalk'
import { rm } from 'fs/promises'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { binaryManager } from '../../core/binary-manager'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'
import {
  detectPackageManager,
  checkEngineDependencies,
  installEngineDependencies,
  getManualInstallInstructions,
  getCurrentPlatform,
} from '../../core/dependency-manager'
import { promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiError, uiWarning, uiInfo, uiSuccess, formatBytes } from '../ui/theme'
import { getEngineIcon, ENGINE_ICONS } from '../constants'
import {
  getInstalledEngines,
  getInstalledPostgresEngines,
  type InstalledPostgresEngine,
  type InstalledMysqlEngine,
  type InstalledSqliteEngine,
  type InstalledMongodbEngine,
  type InstalledRedisEngine,
} from '../helpers'
import { Engine } from '../../types'

/**
 * Pad string to width, accounting for emoji taking 2 display columns
 */
function padWithEmoji(str: string, width: number): string {
  // Count emojis using Extended_Pictographic (excludes digits/symbols that \p{Emoji} matches)
  const emojiCount = (str.match(/\p{Extended_Pictographic}/gu) || []).length
  return str.padEnd(width + emojiCount)
}

/**
 * List subcommand action
 */
async function listEngines(options: { json?: boolean }): Promise<void> {
  const engines = await getInstalledEngines()

  if (options.json) {
    console.log(JSON.stringify(engines, null, 2))
    return
  }

  if (engines.length === 0) {
    console.log(uiInfo('No engines installed yet.'))
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

  // Separate engines by type
  const pgEngines = engines.filter(
    (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
  )
  const mysqlEngine = engines.find(
    (e): e is InstalledMysqlEngine => e.engine === 'mysql',
  )
  const sqliteEngine = engines.find(
    (e): e is InstalledSqliteEngine => e.engine === 'sqlite',
  )
  const mongodbEngine = engines.find(
    (e): e is InstalledMongodbEngine => e.engine === 'mongodb',
  )
  const redisEngine = engines.find(
    (e): e is InstalledRedisEngine => e.engine === 'redis',
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
    const engineDisplay = `${icon} ${engine.engine}`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(engine.version.padEnd(12)) +
        chalk.gray(platformInfo.padEnd(18)) +
        chalk.white(formatBytes(engine.sizeBytes)),
    )
  }

  // MySQL row
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

  // SQLite row
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

  // MongoDB row
  if (mongodbEngine) {
    const icon = ENGINE_ICONS.mongodb
    const engineDisplay = `${icon} mongodb`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(mongodbEngine.version.padEnd(12)) +
        chalk.gray('system'.padEnd(18)) +
        chalk.gray('(system-installed)'),
    )
  }

  // Redis row
  if (redisEngine) {
    const icon = ENGINE_ICONS.redis
    const engineDisplay = `${icon} redis`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(redisEngine.version.padEnd(12)) +
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
  if (sqliteEngine) {
    console.log(
      chalk.gray(`  SQLite: system-installed at ${sqliteEngine.path}`),
    )
  }
  if (mongodbEngine) {
    console.log(
      chalk.gray(`  MongoDB: system-installed at ${mongodbEngine.path}`),
    )
  }
  if (redisEngine) {
    console.log(
      chalk.gray(`  Redis: system-installed at ${redisEngine.path}`),
    )
  }
  console.log()
}

/**
 * Delete subcommand action
 */
async function deleteEngine(
  engine: string | undefined,
  version: string | undefined,
  options: { yes?: boolean },
): Promise<void> {
  // Get PostgreSQL engines only (MySQL can't be deleted via spindb)
  const pgEngines = await getInstalledPostgresEngines()

  if (pgEngines.length === 0) {
    console.log(uiWarning('No deletable engines found.'))
    console.log(
      chalk.gray(
        '  MySQL is system-installed and cannot be deleted via spindb.',
      ),
    )
    return
  }

  let engineName = engine
  let engineVersion = version

  // Interactive selection if not provided
  if (!engineName || !engineVersion) {
    const choices = pgEngines.map((e) => ({
      name: `${getEngineIcon(e.engine)} ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `${e.engine}:${e.version}:${e.path}`,
    }))

    const { selected } = await inquirer.prompt<{ selected: string }>([
      {
        type: 'list',
        name: 'selected',
        message: 'Select engine to delete:',
        choices,
      },
    ])

    const [eng, ver] = selected.split(':')
    engineName = eng
    engineVersion = ver
  }

  // Find the engine
  const targetEngine = pgEngines.find(
    (e) => e.engine === engineName && e.version === engineVersion,
  )

  if (!targetEngine) {
    console.error(uiError(`Engine "${engineName} ${engineVersion}" not found`))
    process.exit(1)
  }

  // Check if any containers are using this engine version
  const containers = await containerManager.list()
  const usingContainers = containers.filter(
    (c) => c.engine === engineName && c.version === engineVersion,
  )

  if (usingContainers.length > 0) {
    console.error(
      uiError(
        `Cannot delete: ${usingContainers.length} container(s) are using ${engineName} ${engineVersion}`,
      ),
    )
    console.log(
      chalk.gray(
        `  Containers: ${usingContainers.map((c) => c.name).join(', ')}`,
      ),
    )
    console.log()
    console.log(chalk.gray('  Delete these containers first, then try again.'))
    process.exit(1)
  }

  // Confirm deletion
  if (!options.yes) {
    const confirmed = await promptConfirm(
      `Delete ${engineName} ${engineVersion}? This cannot be undone.`,
      false,
    )

    if (!confirmed) {
      console.log(uiWarning('Deletion cancelled'))
      return
    }
  }

  // Delete the engine
  const spinner = createSpinner(`Deleting ${engineName} ${engineVersion}...`)
  spinner.start()

  try {
    await rm(targetEngine.path, { recursive: true, force: true })
    spinner.succeed(`Deleted ${engineName} ${engineVersion}`)
  } catch (error) {
    const e = error as Error
    spinner.fail(`Failed to delete: ${e.message}`)
    process.exit(1)
  }
}

// Install an engine via system package manager
async function installEngineViaPackageManager(
  engine: string,
  displayName: string,
): Promise<void> {
  // Check if already installed
  const statuses = await checkEngineDependencies(engine)
  const allInstalled = statuses.every((s) => s.installed)

  if (allInstalled) {
    console.log(uiInfo(`${displayName} is already installed.`))
    for (const status of statuses) {
      if (status.path) {
        console.log(chalk.gray(`  ${status.dependency.binary}: ${status.path}`))
      }
    }
    return
  }

  // Detect package manager
  const packageManager = await detectPackageManager()

  if (!packageManager) {
    console.error(uiError('No supported package manager found.'))
    console.log()
    console.log(chalk.yellow('Manual installation instructions:'))
    const platform = getCurrentPlatform()
    const missingDeps = statuses.filter((s) => !s.installed)
    for (const status of missingDeps) {
      const instructions = getManualInstallInstructions(
        status.dependency,
        platform,
      )
      console.log(chalk.gray(`  ${status.dependency.name}:`))
      for (const instruction of instructions) {
        console.log(chalk.gray(`    ${instruction}`))
      }
    }
    process.exit(1)
  }

  console.log(uiInfo(`Installing ${displayName} via ${packageManager.name}...`))
  console.log()

  // Install missing dependencies
  const results = await installEngineDependencies(engine, packageManager)

  // Report results
  const succeeded = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  if (succeeded.length > 0) {
    console.log()
    console.log(uiSuccess(`${displayName} installed successfully.`))

    // Show installed paths
    const newStatuses = await checkEngineDependencies(engine)
    for (const status of newStatuses) {
      if (status.installed && status.path) {
        console.log(chalk.gray(`  ${status.dependency.binary}: ${status.path}`))
      }
    }
  }

  if (failed.length > 0) {
    console.log()
    console.error(uiError('Some components failed to install:'))
    for (const result of failed) {
      console.error(chalk.red(`  ${result.dependency.name}: ${result.error}`))
    }
    process.exit(1)
  }

  // Check if some dependencies couldn't be installed because the package manager
  // doesn't have a package definition for them (e.g., Redis on Windows with Chocolatey)
  if (results.length === 0) {
    const stillMissing = statuses.filter((s) => !s.installed)
    if (stillMissing.length > 0) {
      console.log()
      console.log(
        uiWarning(
          `${packageManager.name} doesn't have packages for ${displayName}.`,
        ),
      )
      console.log()
      console.log(chalk.yellow('Manual installation required:'))
      const platform = getCurrentPlatform()
      for (const status of stillMissing) {
        const instructions = getManualInstallInstructions(
          status.dependency,
          platform,
        )
        console.log(chalk.gray(`  ${status.dependency.name}:`))
        for (const instruction of instructions) {
          console.log(chalk.gray(`    ${instruction}`))
        }
      }
      process.exit(1)
    }
  }
}

// Main engines command
export const enginesCommand = new Command('engines')
  .description('Manage installed database engines')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      await listEngines(options)
    } catch (error) {
      const e = error as Error
      console.error(uiError(e.message))
      process.exit(1)
    }
  })

// Delete subcommand
enginesCommand
  .command('delete [engine] [version]')
  .description('Delete an installed engine version')
  .option('-y, --yes', 'Skip confirmation')
  .action(
    async (
      engine: string | undefined,
      version: string | undefined,
      options: { yes?: boolean },
    ) => {
      try {
        await deleteEngine(engine, version, options)
      } catch (error) {
        const e = error as Error
        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )

// Download subcommand
enginesCommand
  .command('download <engine> [version]')
  .description('Download/install engine binaries')
  .action(async (engineName: string, version?: string) => {
    try {
      const normalizedEngine = engineName.toLowerCase()

      // PostgreSQL: download binaries
      if (['postgresql', 'pg', 'postgres'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('PostgreSQL requires a version (e.g., 17)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.PostgreSQL)

        const spinner = createSpinner(
          `Checking PostgreSQL ${version} binaries...`,
        )
        spinner.start()

        // Always call ensureBinaries - it handles cached binaries gracefully
        // and registers client tool paths in config (needed for dependency checks)
        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `PostgreSQL ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`PostgreSQL ${version} binaries already installed`)
        } else {
          spinner.succeed(`PostgreSQL ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform, arch } = platformService.getPlatformInfo()
        const fullVersion = binaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'postgresql',
          version: fullVersion,
          platform,
          arch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))
        return
      }

      // MySQL and SQLite: install via system package manager
      if (['mysql', 'mariadb'].includes(normalizedEngine)) {
        await installEngineViaPackageManager('mysql', 'MySQL')
        return
      }

      if (['sqlite', 'sqlite3'].includes(normalizedEngine)) {
        await installEngineViaPackageManager('sqlite', 'SQLite')
        return
      }

      if (['mongodb', 'mongo'].includes(normalizedEngine)) {
        await installEngineViaPackageManager('mongodb', 'MongoDB')
        return
      }

      if (normalizedEngine === 'redis') {
        await installEngineViaPackageManager('redis', 'Redis')
        return
      }

      console.error(
        uiError(
          `Unknown engine "${engineName}". Supported: postgresql, mysql, sqlite, mongodb, redis`,
        ),
      )
      process.exit(1)
    } catch (error) {
      const e = error as Error
      console.error(uiError(e.message))
      process.exit(1)
    }
  })
