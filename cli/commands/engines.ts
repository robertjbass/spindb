import { Command } from 'commander'
import chalk from 'chalk'
import { rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { configManager } from '../../core/config-manager'
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
  findBinary,
} from '../../core/dependency-manager'
import {
  getRequiredClientTools,
  getPackagesForTools,
} from '../../core/hostdb-metadata'
import type { BinaryTool } from '../../types'
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
import {
  loadEnginesJson,
  type EngineConfig,
} from '../../config/engines-registry'
import { mysqlBinaryManager } from '../../engines/mysql/binary-manager'
import { mariadbBinaryManager } from '../../engines/mariadb/binary-manager'
import { mongodbBinaryManager } from '../../engines/mongodb/binary-manager'
import { redisBinaryManager } from '../../engines/redis/binary-manager'

// Pad string to width, accounting for emoji taking 2 display columns
function padWithEmoji(str: string, width: number): string {
  // Count emojis using Extended_Pictographic (excludes digits/symbols that \p{Emoji} matches)
  const emojiCount = (str.match(/\p{Extended_Pictographic}/gu) || []).length
  return str.padEnd(width + emojiCount)
}

// Display manual installation instructions for missing dependencies
function displayManualInstallInstructions(
  missingDeps: Array<{ dependency: { name: string }; installed: boolean }>,
): void {
  const platform = getCurrentPlatform()
  for (const status of missingDeps) {
    const instructions = getManualInstallInstructions(
      status.dependency as Parameters<typeof getManualInstallInstructions>[0],
      platform,
    )
    console.log(chalk.gray(`  ${status.dependency.name}:`))
    for (const instruction of instructions) {
      console.log(chalk.gray(`    ${instruction}`))
    }
  }
}

const execAsync = promisify(exec)

/**
 * Check which client tools are bundled in the downloaded binaries
 * @param binPath Path to the extracted binary directory
 * @param tools List of tool names to check
 * @returns Array of tools that were found bundled
 */
function checkBundledTools(binPath: string, tools: string[]): string[] {
  const ext = platformService.getExecutableExtension()
  const bundled: string[] = []

  for (const tool of tools) {
    const toolPath = join(binPath, 'bin', `${tool}${ext}`)
    if (existsSync(toolPath)) {
      bundled.push(tool)
    }
  }

  return bundled
}

/**
 * Install missing client tools using the system package manager
 * Uses hostdb's downloads.json to determine the correct packages
 *
 * @param engine Engine name (e.g., 'postgresql', 'mysql')
 * @param bundledTools Tools already bundled with the downloaded binaries
 * @param onProgress Progress callback for UI updates
 */
async function installMissingClientTools(
  engine: string,
  bundledTools: string[],
  onProgress?: (msg: string) => void,
): Promise<{ installed: string[]; failed: string[]; skipped: string[] }> {
  const installed: string[] = []
  const failed: string[] = []
  const skipped: string[] = []

  // Timeout for package installation commands (5 minutes)
  const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

  // Get required client tools from hostdb databases.json
  const requiredTools = await getRequiredClientTools(engine)
  if (requiredTools.length === 0) {
    return { installed, failed, skipped }
  }

  // Find which tools are missing (not bundled and not already installed)
  const missingTools: string[] = []
  for (const tool of requiredTools) {
    if (bundledTools.includes(tool)) {
      // Already bundled in the download
      continue
    }

    // Check if already installed on system
    const existing = await findBinary(tool)
    if (existing) {
      // Register it in config and skip installation
      await configManager.setBinaryPath(
        tool as BinaryTool,
        existing.path,
        'system',
      )
      skipped.push(tool)
      continue
    }

    missingTools.push(tool)
  }

  if (missingTools.length === 0) {
    return { installed, failed, skipped }
  }

  // Detect package manager
  const pm = await detectPackageManager()
  if (!pm) {
    // No package manager available, all missing tools fail
    return { installed, failed: missingTools, skipped }
  }

  // Map our package manager to hostdb key
  const ALLOWED_PACKAGE_MANAGERS = ['brew', 'apt', 'yum', 'dnf', 'choco'] as const
  type PackageManagerKey = (typeof ALLOWED_PACKAGE_MANAGERS)[number]

  const normalizedName = pm.name.toLowerCase().replace(/[^a-z]/g, '')
  if (!ALLOWED_PACKAGE_MANAGERS.includes(normalizedName as PackageManagerKey)) {
    // Unknown package manager, cannot install automatically
    console.warn(
      `Unknown package manager: ${pm.name}, skipping automatic installation`,
    )
    return { installed, failed: missingTools, skipped }
  }
  const pmKey = normalizedName as PackageManagerKey

  // Get the packages needed for missing tools
  const packages = await getPackagesForTools(missingTools, pmKey)

  // Pattern for validating package names (prevents command injection)
  // Allows alphanumeric, @, ., _, -, / (for scoped packages and paths)
  const SAFE_PACKAGE_PATTERN = /^[@a-zA-Z0-9][a-zA-Z0-9._/-]*$/

  // Check if running as root (no sudo needed)
  const isRoot = process.getuid?.() === 0

  for (const pkg of packages) {
    // Validate package name to prevent command injection
    if (!SAFE_PACKAGE_PATTERN.test(pkg.package)) {
      console.warn(`Skipping invalid package name: ${pkg.package}`)
      failed.push(...pkg.tools)
      continue
    }

    // Also validate tap if present
    if (pkg.tap && !SAFE_PACKAGE_PATTERN.test(pkg.tap)) {
      console.warn(`Skipping invalid tap name: ${pkg.tap}`)
      failed.push(...pkg.tools)
      continue
    }

    onProgress?.(
      `Installing ${pkg.package} (provides: ${pkg.tools.join(', ')})...`,
    )

    try {
      // Handle Homebrew taps
      if (pmKey === 'brew' && pkg.tap) {
        await execAsync(`brew tap ${pkg.tap}`, { timeout: INSTALL_TIMEOUT_MS })
      }

      // Build install command - use sudo only if not root
      const sudo = isRoot ? '' : 'sudo '
      const installCommands: Record<string, string> = {
        brew: `brew install ${pkg.package}`,
        apt: `${sudo}apt-get update && ${sudo}apt-get install -y ${pkg.package}`,
        yum: `${sudo}yum install -y ${pkg.package}`,
        dnf: `${sudo}dnf install -y ${pkg.package}`,
        choco: `choco install ${pkg.package} -y`,
      }
      const installCmd = installCommands[pmKey] ?? null

      if (!installCmd) {
        failed.push(...pkg.tools)
        continue
      }

      await execAsync(installCmd, { timeout: INSTALL_TIMEOUT_MS })

      // Register the installed tools
      for (const tool of pkg.tools) {
        const result = await findBinary(tool)
        if (result) {
          await configManager.setBinaryPath(
            tool as BinaryTool,
            result.path,
            'system',
          )
          installed.push(tool)
        } else {
          // Installed but can't find - maybe needs PATH refresh
          console.warn(
            chalk.yellow(
              `  Warning: ${tool} was installed but its binary was not found. ` +
                'You may need to refresh your PATH and re-run this command.',
            ),
          )
          installed.push(tool) // Still count as installed
        }
      }
    } catch (error) {
      const e = error as Error & { killed?: boolean }
      if (e.killed) {
        // Timeout - process was killed
        console.error(
          chalk.red(
            `  Installation of ${pkg.package} timed out after 5 minutes`,
          ),
        )
      } else {
        console.error(
          chalk.red(`  Failed to install ${pkg.package}: ${e.message}`),
        )
      }
      failed.push(...pkg.tools)
    }
  }

  return { installed, failed, skipped }
}

/**
 * Check for bundled client tools and install any that are missing
 *
 * @param engineName - Engine name (e.g., 'postgresql', 'mysql')
 * @param binPath - Path to the extracted binary directory
 */
async function checkAndInstallClientTools(
  engineName: string,
  binPath: string,
): Promise<void> {
  const requiredTools = await getRequiredClientTools(engineName)
  const bundledTools = checkBundledTools(binPath, requiredTools)

  if (bundledTools.length >= requiredTools.length) {
    return // All tools are bundled
  }

  const clientSpinner = createSpinner('Checking client tools...')
  clientSpinner.start()

  const result = await installMissingClientTools(engineName, bundledTools, (msg) => {
    clientSpinner.text = msg
  })

  // Report all non-empty categories (not mutually exclusive)
  const messages: string[] = []
  if (result.installed.length > 0) {
    messages.push(`installed: ${result.installed.join(', ')}`)
  }
  if (result.skipped.length > 0) {
    messages.push(`already available: ${result.skipped.join(', ')}`)
  }

  if (result.failed.length > 0) {
    if (messages.length > 0) {
      clientSpinner.warn(`${messages.join('; ')}; failed: ${result.failed.join(', ')}`)
    } else {
      clientSpinner.warn(`Could not install: ${result.failed.join(', ')}. Install manually.`)
    }
  } else if (messages.length > 0) {
    clientSpinner.succeed(messages.join('; '))
  } else {
    clientSpinner.succeed('All client tools available')
  }
}

// List subcommand action
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
        '  Database engines are downloaded automatically when you create a container.',
      ),
    )
    console.log(
      chalk.gray(
        '  Or download manually: spindb engines download <engine> <version>',
      ),
    )
    return
  }

  // Separate engines by type
  const pgEngines = engines.filter(
    (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
  )
  const mysqlEngines = engines.filter(
    (e): e is InstalledMysqlEngine => e.engine === 'mysql',
  )
  const sqliteEngine = engines.find(
    (e): e is InstalledSqliteEngine => e.engine === 'sqlite',
  )
  const mongodbEngines = engines.filter(
    (e): e is InstalledMongodbEngine => e.engine === 'mongodb',
  )
  const redisEngines = engines.filter(
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

  // MySQL rows
  for (const mysqlEngine of mysqlEngines) {
    const icon = ENGINE_ICONS.mysql
    const platformInfo = `${mysqlEngine.platform}-${mysqlEngine.arch}`
    const engineDisplay = `${icon} mysql`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(mysqlEngine.version.padEnd(12)) +
        chalk.gray(platformInfo.padEnd(18)) +
        chalk.white(formatBytes(mysqlEngine.sizeBytes)),
    )
  }

  // SQLite row
  if (sqliteEngine) {
    const icon = ENGINE_ICONS.sqlite
    const engineDisplay = `${icon}  sqlite`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(sqliteEngine.version.padEnd(12)) +
        chalk.gray('system'.padEnd(18)) +
        chalk.gray('(system-installed)'),
    )
  }

  // MongoDB rows
  for (const engine of mongodbEngines) {
    const icon = ENGINE_ICONS.mongodb
    const platformInfo = `${engine.platform}-${engine.arch}`
    const engineDisplay = `${icon} mongodb`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(engine.version.padEnd(12)) +
        chalk.gray(platformInfo.padEnd(18)) +
        chalk.white(formatBytes(engine.sizeBytes)),
    )
  }

  // Redis rows
  for (const engine of redisEngines) {
    const icon = ENGINE_ICONS.redis
    const platformInfo = `${engine.platform}-${engine.arch}`
    const engineDisplay = `${icon} redis`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(padWithEmoji(engineDisplay, 13)) +
        chalk.yellow(engine.version.padEnd(12)) +
        chalk.gray(platformInfo.padEnd(18)) +
        chalk.white(formatBytes(engine.sizeBytes)),
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
  if (mysqlEngines.length > 0) {
    const totalMysqlSize = mysqlEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
    console.log(
      chalk.gray(
        `  MySQL: ${mysqlEngines.length} version(s), ${formatBytes(totalMysqlSize)}`,
      ),
    )
  }
  if (sqliteEngine) {
    console.log(
      chalk.gray(`  SQLite: system-installed at ${sqliteEngine.path}`),
    )
  }
  if (mongodbEngines.length > 0) {
    const totalMongodbSize = mongodbEngines.reduce(
      (acc, e) => acc + e.sizeBytes,
      0,
    )
    console.log(
      chalk.gray(
        `  MongoDB: ${mongodbEngines.length} version(s), ${formatBytes(totalMongodbSize)}`,
      ),
    )
  }
  if (redisEngines.length > 0) {
    const totalRedisSize = redisEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
    console.log(
      chalk.gray(
        `  Redis: ${redisEngines.length} version(s), ${formatBytes(totalRedisSize)}`,
      ),
    )
  }
  console.log()
}

// Delete subcommand action
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
        '  Engine deletion is currently supported for PostgreSQL only.',
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

  // Check if any containers are using this engine version (for warning only)
  const containers = await containerManager.list()
  const usingContainers = containers.filter(
    (c) => c.engine === engineName && c.version === engineVersion,
  )

  // Check for running containers using this engine
  const runningContainers = usingContainers.filter(
    (c) => c.status === 'running',
  )

  // Confirm deletion (warn about containers)
  if (!options.yes) {
    if (usingContainers.length > 0) {
      const runningCount = runningContainers.length
      const stoppedCount = usingContainers.length - runningCount

      if (runningCount > 0) {
        console.log(
          uiWarning(
            `${runningCount} running container(s) will be stopped: ${runningContainers.map((c) => c.name).join(', ')}`,
          ),
        )
      }
      if (stoppedCount > 0) {
        const stoppedContainers = usingContainers.filter(
          (c) => c.status !== 'running',
        )
        console.log(
          chalk.gray(
            `  ${stoppedCount} stopped container(s) will be orphaned: ${stoppedContainers.map((c) => c.name).join(', ')}`,
          ),
        )
      }
      console.log(
        chalk.gray(
          '  You can re-download the engine later to use these containers.',
        ),
      )
      console.log()
    }

    const confirmed = await promptConfirm(
      `Delete ${engineName} ${engineVersion}? This cannot be undone.`,
      false,
    )

    if (!confirmed) {
      console.log(uiWarning('Deletion cancelled'))
      return
    }
  }

  // Stop any running containers first (while we still have the binary)
  if (runningContainers.length > 0) {
    const stopSpinner = createSpinner(
      `Stopping ${runningContainers.length} running container(s)...`,
    )
    stopSpinner.start()

    const engine = getEngine(Engine.PostgreSQL)
    const failedToStop: string[] = []

    for (const container of runningContainers) {
      stopSpinner.text = `Stopping ${container.name}...`
      try {
        await engine.stop(container)
        await containerManager.updateConfig(container.name, {
          status: 'stopped',
        })
      } catch (error) {
        // Log the original failure before attempting fallback
        const err = error as Error
        console.error(
          chalk.gray(
            `  Failed to stop ${container.name} via engine.stop: ${err.message}`,
          ),
        )
        // Try fallback kill
        const killed = await processManager.killProcess(container.name, {
          engine: container.engine,
        })
        if (killed) {
          await containerManager.updateConfig(container.name, {
            status: 'stopped',
          })
        } else {
          failedToStop.push(container.name)
        }
      }
    }

    if (failedToStop.length > 0) {
      stopSpinner.warn(
        `Could not stop ${failedToStop.length} container(s): ${failedToStop.join(', ')}`,
      )
      console.log(
        chalk.yellow(
          '  These containers may still be running. Deleting the engine could leave them in a broken state.',
        ),
      )

      if (!options.yes) {
        const continueAnyway = await promptConfirm(
          'Continue with engine deletion anyway?',
          false,
        )
        if (!continueAnyway) {
          console.log(uiWarning('Deletion cancelled'))
          return
        }
      } else {
        console.log(
          chalk.yellow('  Proceeding with deletion (--yes specified)'),
        )
      }
    } else {
      stopSpinner.succeed(`Stopped ${runningContainers.length} container(s)`)
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
    const missingDeps = statuses.filter((s) => !s.installed)
    displayManualInstallInstructions(missingDeps)
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
      displayManualInstallInstructions(stillMissing)
      process.exit(1)
    }
  }
}

// Main engines command
export const enginesCommand = new Command('engines')
  .description('Manage installed database engines')
  .action(async () => {
    try {
      // Default action: list installed engines (same as 'engines list')
      await listEngines({})
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

        // Check for bundled client tools and install missing ones
        await checkAndInstallClientTools('postgresql', binPath)
        return
      }

      // MySQL: download from hostdb
      if (['mysql'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('MySQL requires a version (e.g., 8.0, 8.4, 9)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.MySQL)

        const spinner = createSpinner(`Checking MySQL ${version} binaries...`)
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `MySQL ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`MySQL ${version} binaries already installed`)
        } else {
          spinner.succeed(`MySQL ${version} binaries downloaded`)
        }

        const { platform: mysqlPlatform, arch: mysqlArch } =
          platformService.getPlatformInfo()
        const mysqlFullVersion = mysqlBinaryManager.getFullVersion(version)
        const mysqlBinPath = paths.getBinaryPath({
          engine: 'mysql',
          version: mysqlFullVersion,
          platform: mysqlPlatform,
          arch: mysqlArch,
        })
        console.log(chalk.gray(`  Location: ${mysqlBinPath}`))

        // Check for bundled client tools and install missing ones
        await checkAndInstallClientTools('mysql', mysqlBinPath)
        return
      }

      // MariaDB: download from hostdb
      if (['mariadb', 'maria'].includes(normalizedEngine)) {
        if (!version) {
          console.error(
            uiError('MariaDB requires a version (e.g., 10.11, 11.4, 11.8)'),
          )
          process.exit(1)
        }

        const engine = getEngine(Engine.MariaDB)

        const spinner = createSpinner(`Checking MariaDB ${version} binaries...`)
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `MariaDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`MariaDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`MariaDB ${version} binaries downloaded`)
        }

        const { platform: mariadbPlatform, arch: mariadbArch } =
          platformService.getPlatformInfo()
        const mariadbFullVersion = mariadbBinaryManager.getFullVersion(version)
        const mariadbBinPath = paths.getBinaryPath({
          engine: 'mariadb',
          version: mariadbFullVersion,
          platform: mariadbPlatform,
          arch: mariadbArch,
        })
        console.log(chalk.gray(`  Location: ${mariadbBinPath}`))

        // Check for bundled client tools and install missing ones
        await checkAndInstallClientTools('mariadb', mariadbBinPath)
        return
      }

      if (['sqlite', 'sqlite3'].includes(normalizedEngine)) {
        await installEngineViaPackageManager('sqlite', 'SQLite')
        return
      }

      if (['mongodb', 'mongo'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('MongoDB requires a version (e.g., 7.0, 8.0)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.MongoDB)

        const spinner = createSpinner(`Checking MongoDB ${version} binaries...`)
        spinner.start()

        // Always call ensureBinaries - it handles cached binaries gracefully
        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `MongoDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`MongoDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`MongoDB ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform, arch } = platformService.getPlatformInfo()
        const fullVersion = mongodbBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'mongodb',
          version: fullVersion,
          platform,
          arch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Check for bundled client tools and install missing ones
        await checkAndInstallClientTools('mongodb', binPath)
        return
      }

      if (normalizedEngine === 'redis') {
        if (!version) {
          console.error(uiError('Redis requires a version (e.g., 8)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.Redis)

        const spinner = createSpinner(`Checking Redis ${version} binaries...`)
        spinner.start()

        // Always call ensureBinaries - it handles cached binaries gracefully
        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `Redis ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`Redis ${version} binaries already installed`)
        } else {
          spinner.succeed(`Redis ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: redisPlatform, arch: redisArch } =
          platformService.getPlatformInfo()
        const redisFullVersion = redisBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'redis',
          version: redisFullVersion,
          platform: redisPlatform,
          arch: redisArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Check for bundled client tools and install missing ones
        await checkAndInstallClientTools('redis', binPath)
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

// List subcommand (explicit alias for default action)
enginesCommand
  .command('list')
  .description('List installed database engines')
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

// Supported subcommand - list all supported engines from engines.json
enginesCommand
  .command('supported')
  .description('List all supported database engines')
  .option('--json', 'Output as JSON')
  .option('--all', 'Include pending and planned engines')
  .action(async (options: { json?: boolean; all?: boolean }) => {
    try {
      const enginesData = await loadEnginesJson()

      if (options.json) {
        // Output full JSON
        console.log(JSON.stringify(enginesData, null, 2))
        return
      }

      // Simple list output
      const entries = Object.entries(enginesData.engines) as [
        string,
        EngineConfig,
      ][]

      for (const [name, config] of entries) {
        // Skip non-integrated unless --all flag is set
        if (!options.all && config.status !== 'integrated') {
          continue
        }

        if (options.all) {
          // Show status in parentheses
          const statusColor =
            config.status === 'integrated'
              ? chalk.green
              : config.status === 'pending'
                ? chalk.blue
                : chalk.gray
          console.log(
            `${config.icon} ${name} ${statusColor(`(${config.status})`)}`,
          )
        } else {
          // Just engine name with icon
          console.log(`${config.icon} ${name}`)
        }
      }
    } catch (error) {
      const e = error as Error
      console.error(uiError(e.message))
      process.exit(1)
    }
  })
