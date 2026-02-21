import { Command } from 'commander'
import chalk from 'chalk'
import { rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { configManager } from '../../core/config-manager'
import { getEngine } from '../../engines'
import { postgresqlBinaryManager } from '../../engines/postgresql/binary-manager'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'
import {
  detectPackageManager,
  findBinary,
} from '../../core/dependency-manager'
import {
  getRequiredClientTools,
  getPackagesForTools,
} from '../../core/hostdb-metadata'
import type { BinaryTool } from '../../types'
import { promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiError, uiWarning, uiInfo, formatBytes } from '../ui/theme'
import { getEngineIcon } from '../constants'
import {
  getInstalledEngines,
  getInstalledPostgresEngines,
  getEngineMetadata,
} from '../helpers'
import { Engine, Platform, ALL_ENGINES } from '../../types'
import {
  loadEnginesJson,
  filterEnginesByPlatform,
  type EngineConfig,
} from '../../config/engines-registry'
import { mysqlBinaryManager } from '../../engines/mysql/binary-manager'
import { mariadbBinaryManager } from '../../engines/mariadb/binary-manager'
import { mongodbBinaryManager } from '../../engines/mongodb/binary-manager'
import { redisBinaryManager } from '../../engines/redis/binary-manager'
import { valkeyBinaryManager } from '../../engines/valkey/binary-manager'
import { sqliteBinaryManager } from '../../engines/sqlite/binary-manager'
import { duckdbBinaryManager } from '../../engines/duckdb/binary-manager'
import { clickhouseBinaryManager } from '../../engines/clickhouse/binary-manager'
import { qdrantBinaryManager } from '../../engines/qdrant/binary-manager'
import { meilisearchBinaryManager } from '../../engines/meilisearch/binary-manager'
import { ferretdbBinaryManager } from '../../engines/ferretdb/binary-manager'
import { couchdbBinaryManager } from '../../engines/couchdb/binary-manager'
import { cockroachdbBinaryManager } from '../../engines/cockroachdb/binary-manager'
import { surrealdbBinaryManager } from '../../engines/surrealdb/binary-manager'
import { questdbBinaryManager } from '../../engines/questdb/binary-manager'
import { typedbBinaryManager } from '../../engines/typedb/binary-manager'
import { influxdbBinaryManager } from '../../engines/influxdb/binary-manager'
import { weaviateBinaryManager } from '../../engines/weaviate/binary-manager'
import { tigerbeetleBinaryManager } from '../../engines/tigerbeetle/binary-manager'
import {
  DEFAULT_DOCUMENTDB_VERSION,
  DEFAULT_V1_POSTGRESQL_VERSION,
  normalizeDocumentDBVersion,
  isV1,
} from '../../engines/ferretdb/version-maps'

const execFileAsync = promisify(execFile)

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
): Promise<{
  installed: string[]
  failed: string[]
  skipped: string[]
  needsPathRefresh: string[]
}> {
  const installed: string[] = []
  const failed: string[] = []
  const skipped: string[] = []
  const needsPathRefresh: string[] = []

  // Timeout for package installation commands (5 minutes)
  const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

  // Get required client tools from hostdb databases.json
  const requiredTools = await getRequiredClientTools(engine)
  if (requiredTools.length === 0) {
    return { installed, failed, skipped, needsPathRefresh }
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
    return { installed, failed, skipped, needsPathRefresh }
  }

  // Detect package manager
  const pm = await detectPackageManager()
  if (!pm) {
    // No package manager available, all missing tools fail
    return { installed, failed: missingTools, skipped, needsPathRefresh }
  }

  // Package manager keys supported by hostdb
  type PackageManagerKey = 'brew' | 'apt' | 'yum' | 'dnf' | 'choco'

  // Explicit mapping from package manager name variants to canonical keys
  const PACKAGE_MANAGER_ALIASES: Record<string, PackageManagerKey> = {
    // Homebrew
    brew: 'brew',
    homebrew: 'brew',
    // APT
    apt: 'apt',
    'apt-get': 'apt',
    aptget: 'apt',
    // YUM
    yum: 'yum',
    // DNF
    dnf: 'dnf',
    // Chocolatey
    choco: 'choco',
    chocolatey: 'choco',
  }

  const lookupKey = pm.name.toLowerCase().trim()
  const pmKey = PACKAGE_MANAGER_ALIASES[lookupKey]

  if (!pmKey) {
    // Unknown package manager, cannot install automatically
    console.warn(
      `Unknown package manager: ${pm.name}, skipping automatic installation`,
    )
    return { installed, failed: missingTools, skipped, needsPathRefresh }
  }

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
        await execFileAsync('brew', ['tap', pkg.tap], {
          timeout: INSTALL_TIMEOUT_MS,
        })
      }

      // All package managers use execFileAsync with explicit argument arrays
      if (pmKey === 'apt') {
        // APT: Run apt-get update and apt-get install as separate commands
        const aptExecutable = isRoot ? 'apt-get' : 'sudo'
        const updateArgs = isRoot ? ['update'] : ['apt-get', 'update']
        const installArgs = isRoot
          ? ['install', '-y', pkg.package]
          : ['apt-get', 'install', '-y', pkg.package]

        await execFileAsync(aptExecutable, updateArgs, {
          timeout: INSTALL_TIMEOUT_MS,
        })
        await execFileAsync(aptExecutable, installArgs, {
          timeout: INSTALL_TIMEOUT_MS,
        })
      } else if (pmKey === 'brew') {
        // Homebrew: No sudo needed
        await execFileAsync('brew', ['install', pkg.package], {
          timeout: INSTALL_TIMEOUT_MS,
        })
      } else if (pmKey === 'yum') {
        // YUM: Needs sudo for non-root
        const executable = isRoot ? 'yum' : 'sudo'
        const args = isRoot
          ? ['install', '-y', pkg.package]
          : ['yum', 'install', '-y', pkg.package]
        await execFileAsync(executable, args, { timeout: INSTALL_TIMEOUT_MS })
      } else if (pmKey === 'dnf') {
        // DNF: Needs sudo for non-root
        const executable = isRoot ? 'dnf' : 'sudo'
        const args = isRoot
          ? ['install', '-y', pkg.package]
          : ['dnf', 'install', '-y', pkg.package]
        await execFileAsync(executable, args, { timeout: INSTALL_TIMEOUT_MS })
      } else if (pmKey === 'choco') {
        // Chocolatey: No sudo on Windows
        await execFileAsync('choco', ['install', pkg.package, '-y'], {
          timeout: INSTALL_TIMEOUT_MS,
        })
      } else {
        // Unknown package manager - should not reach here due to earlier validation
        failed.push(...pkg.tools)
        continue
      }

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
          // Package installed but binary not found in PATH
          // This is likely a PATH refresh issue, not an installation failure
          needsPathRefresh.push(tool)
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

  return { installed, failed, skipped, needsPathRefresh }
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

  const result = await installMissingClientTools(
    engineName,
    bundledTools,
    (msg) => {
      clientSpinner.text = msg
    },
  )

  // Report all non-empty categories (not mutually exclusive)
  const messages: string[] = []
  if (result.installed.length > 0) {
    messages.push(`installed: ${result.installed.join(', ')}`)
  }
  if (result.skipped.length > 0) {
    messages.push(`already available: ${result.skipped.join(', ')}`)
  }

  // Determine overall status
  const hasFailures = result.failed.length > 0
  const hasPathIssues = result.needsPathRefresh.length > 0

  if (hasFailures || hasPathIssues) {
    // Build warning message
    const warnings: string[] = []
    if (result.failed.length > 0) {
      warnings.push(`failed: ${result.failed.join(', ')}`)
    }
    if (result.needsPathRefresh.length > 0) {
      warnings.push(`needs PATH refresh: ${result.needsPathRefresh.join(', ')}`)
    }

    if (messages.length > 0) {
      clientSpinner.warn(`${messages.join('; ')}; ${warnings.join('; ')}`)
    } else {
      clientSpinner.warn(warnings.join('; '))
    }

    // Show additional help for PATH issues
    if (hasPathIssues) {
      console.log(
        chalk.yellow(
          '  Some tools were installed but not found in PATH. Refresh your shell and re-run:',
        ),
      )
      console.log(chalk.gray(`    spindb engines download ${engineName}`))
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
    const enginesWithMetadata = await Promise.all(
      engines.map(async (e) => ({
        ...e,
        ...(await getEngineMetadata(e.engine)),
      })),
    )
    console.log(JSON.stringify(enginesWithMetadata, null, 2))
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

  // Sort engines alphabetically by engine name
  const sortedEngines = [...engines].sort((a, b) =>
    a.engine.localeCompare(b.engine),
  )

  // Table header
  // Icon is 5 chars, longest engine name is 11 (meilisearch/cockroachdb), so 18 total for ENGINE column
  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.bold.white('ENGINE'.padEnd(18)) +
      chalk.bold.white('VERSION'.padEnd(12)) +
      chalk.bold.white('SOURCE'.padEnd(18)) +
      chalk.bold.white('SIZE'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(59)))

  // Display all engines in alphabetical order
  for (const engine of sortedEngines) {
    const platformInfo = `${engine.platform}-${engine.arch}`

    console.log(
      chalk.gray('  ') +
        getEngineIcon(engine.engine) +
        chalk.cyan(engine.engine.padEnd(13)) +
        chalk.yellow(engine.version.padEnd(12)) +
        chalk.gray(platformInfo.padEnd(18)) +
        chalk.white(formatBytes(engine.sizeBytes)),
    )
  }

  console.log(chalk.gray('  ' + '─'.repeat(59)))

  // Summary - group by engine name (already sorted)
  console.log()

  // Engine display name map for summary
  const ENGINE_DISPLAY_NAMES: Record<string, string> = {
    clickhouse: 'ClickHouse',
    cockroachdb: 'CockroachDB',
    couchdb: 'CouchDB',
    duckdb: 'DuckDB',
    ferretdb: 'FerretDB',
    influxdb: 'InfluxDB',
    mariadb: 'MariaDB',
    meilisearch: 'Meilisearch',
    mongodb: 'MongoDB',
    mysql: 'MySQL',
    postgresql: 'PostgreSQL',
    qdrant: 'Qdrant',
    questdb: 'QuestDB',
    redis: 'Redis',
    sqlite: 'SQLite',
    surrealdb: 'SurrealDB',
    typedb: 'TypeDB',
    valkey: 'Valkey',
    weaviate: 'Weaviate',
    tigerbeetle: 'TigerBeetle',
  }

  // Group engines by name for summary
  const engineGroups = new Map<string, typeof sortedEngines>()
  for (const engine of sortedEngines) {
    const group = engineGroups.get(engine.engine) || []
    group.push(engine)
    engineGroups.set(engine.engine, group)
  }

  for (const [engineName, group] of engineGroups) {
    const displayName = ENGINE_DISPLAY_NAMES[engineName] || engineName
    const totalSize = group.reduce((acc, e) => acc + e.sizeBytes, 0)
    console.log(
      chalk.gray(
        `  ${displayName}: ${group.length} version(s), ${formatBytes(totalSize)}`,
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
      name: `${getEngineIcon(e.engine)}${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
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

    // Check for cross-engine dependencies (QuestDB depends on PostgreSQL's psql)
    if (engineName === Engine.PostgreSQL) {
      const questdbContainers = containers.filter(
        (c) => c.engine === Engine.QuestDB,
      )
      if (questdbContainers.length > 0) {
        console.log(
          uiWarning(
            `${questdbContainers.length} QuestDB container(s) depend on PostgreSQL's psql for backup/restore:`,
          ),
        )
        console.log(
          chalk.gray(`  ${questdbContainers.map((c) => c.name).join(', ')}`),
        )
        console.log(
          chalk.gray(
            '  Deleting PostgreSQL will break backup/restore for these containers.',
          ),
        )
        console.log()
      }
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

// Main engines command
export const enginesCommand = new Command('engines')
  .description('Manage installed database engines')
  .option('--json', 'Output as JSON')
  .passThroughOptions()
  .action(async (options: { json?: boolean }) => {
    try {
      // Default action: list installed engines (same as 'engines list')
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
        const fullVersion = postgresqlBinaryManager.getFullVersion(version)
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
        if (!version) {
          console.error(uiError('SQLite requires a version (e.g., 3)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.SQLite)

        const spinner = createSpinner(`Checking SQLite ${version} binaries...`)
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `SQLite ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`SQLite ${version} binaries already installed`)
        } else {
          spinner.succeed(`SQLite ${version} binaries downloaded`)
        }

        const { platform: sqlitePlatform, arch: sqliteArch } =
          platformService.getPlatformInfo()
        const sqliteFullVersion = sqliteBinaryManager.getFullVersion(version)
        const sqliteBinPath = paths.getBinaryPath({
          engine: 'sqlite',
          version: sqliteFullVersion,
          platform: sqlitePlatform,
          arch: sqliteArch,
        })
        console.log(chalk.gray(`  Location: ${sqliteBinPath}`))
        return
      }

      if (['duckdb', 'duck'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('DuckDB requires a version (e.g., 1)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.DuckDB)

        const spinner = createSpinner(`Checking DuckDB ${version} binaries...`)
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `DuckDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`DuckDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`DuckDB ${version} binaries downloaded`)
        }

        const { platform: duckdbPlatform, arch: duckdbArch } =
          platformService.getPlatformInfo()
        const duckdbFullVersion = duckdbBinaryManager.getFullVersion(version)
        const duckdbBinPath = paths.getBinaryPath({
          engine: 'duckdb',
          version: duckdbFullVersion,
          platform: duckdbPlatform,
          arch: duckdbArch,
        })
        console.log(chalk.gray(`  Location: ${duckdbBinPath}`))
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

      if (normalizedEngine === 'valkey') {
        if (!version) {
          console.error(uiError('Valkey requires a version (e.g., 9)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.Valkey)

        const spinner = createSpinner(`Checking Valkey ${version} binaries...`)
        spinner.start()

        // Always call ensureBinaries - it handles cached binaries gracefully
        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `Valkey ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`Valkey ${version} binaries already installed`)
        } else {
          spinner.succeed(`Valkey ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: valkeyPlatform, arch: valkeyArch } =
          platformService.getPlatformInfo()
        const valkeyFullVersion = valkeyBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'valkey',
          version: valkeyFullVersion,
          platform: valkeyPlatform,
          arch: valkeyArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Check for bundled client tools and install missing ones
        await checkAndInstallClientTools('valkey', binPath)
        return
      }

      if (['clickhouse', 'ch'].includes(normalizedEngine)) {
        // Check platform support
        const { platform } = platformService.getPlatformInfo()
        if (platform === Platform.Win32) {
          console.error(
            uiError('ClickHouse is not supported on Windows via hostdb'),
          )
          console.log(
            chalk.gray(
              '  ClickHouse binaries are only available for macOS and Linux.',
            ),
          )
          process.exit(1)
        }

        if (!version) {
          console.error(uiError('ClickHouse requires a version (e.g., 25.12)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.ClickHouse)

        const spinner = createSpinner(
          `Checking ClickHouse ${version} binaries...`,
        )
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `ClickHouse ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`ClickHouse ${version} binaries already installed`)
        } else {
          spinner.succeed(`ClickHouse ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: chPlatform, arch: chArch } =
          platformService.getPlatformInfo()
        const chFullVersion = clickhouseBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'clickhouse',
          version: chFullVersion,
          platform: chPlatform,
          arch: chArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Check for bundled client tools and install missing ones
        await checkAndInstallClientTools('clickhouse', binPath)
        return
      }

      if (['qdrant', 'qd'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('Qdrant requires a version (e.g., 1)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.Qdrant)

        const spinner = createSpinner(`Checking Qdrant ${version} binaries...`)
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `Qdrant ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`Qdrant ${version} binaries already installed`)
        } else {
          spinner.succeed(`Qdrant ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: qdrantPlatform, arch: qdrantArch } =
          platformService.getPlatformInfo()
        const qdrantFullVersion = qdrantBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'qdrant',
          version: qdrantFullVersion,
          platform: qdrantPlatform,
          arch: qdrantArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Skip client tools check for Qdrant - it's a REST API server
        // with no CLI client tools (uses HTTP/gRPC protocols instead)
        return
      }

      if (['meilisearch', 'meili', 'ms'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('Meilisearch requires a version (e.g., 1)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.Meilisearch)

        const spinner = createSpinner(
          `Checking Meilisearch ${version} binaries...`,
        )
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `Meilisearch ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`Meilisearch ${version} binaries already installed`)
        } else {
          spinner.succeed(`Meilisearch ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: meilisearchPlatform, arch: meilisearchArch } =
          platformService.getPlatformInfo()
        const meilisearchFullVersion =
          meilisearchBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'meilisearch',
          version: meilisearchFullVersion,
          platform: meilisearchPlatform,
          arch: meilisearchArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Skip client tools check for Meilisearch - it's a REST API server
        // with no CLI client tools (uses HTTP protocols instead)
        return
      }

      if (['ferretdb', 'ferret'].includes(normalizedEngine)) {
        const { platform } = platformService.getPlatformInfo()

        if (!version) {
          // Auto-select v1 on Windows (v2 not supported)
          if (platform === Platform.Win32) {
            version = '1'
            console.log(
              chalk.gray(
                '  Auto-selecting FerretDB v1 (v2 is not available on Windows)',
              ),
            )
          } else {
            console.error(uiError('FerretDB requires a version (e.g., 1 or 2)'))
            process.exit(1)
          }
        }

        // Block v2 on Windows with helpful message
        if (platform === Platform.Win32 && !isV1(version)) {
          console.error(
            uiError(
              'FerretDB v2 is not supported on Windows (postgresql-documentdb has startup issues)',
            ),
          )
          console.log(
            chalk.gray(
              '  Use FerretDB v1 instead, which uses plain PostgreSQL:',
            ),
          )
          console.log(chalk.cyan('    spindb engines download ferretdb 1'))
          process.exit(1)
        }

        const engine = getEngine(Engine.FerretDB)
        const v1 = isV1(version)

        const spinner = createSpinner(
          `Checking FerretDB ${version} binaries...`,
        )
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `FerretDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`FerretDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`FerretDB ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: ferretPlatform, arch: ferretArch } =
          platformService.getPlatformInfo()
        const ferretFullVersion = ferretdbBinaryManager.getFullVersion(version)
        const binPath = ferretdbBinaryManager.getFerretDBBinaryPath(
          ferretFullVersion,
          ferretPlatform,
          ferretArch,
        )
        console.log(chalk.gray(`  FerretDB location: ${binPath}`))

        // Show backend location (version-dependent)
        if (v1) {
          const pgFullVersion = postgresqlBinaryManager.getFullVersion(
            DEFAULT_V1_POSTGRESQL_VERSION,
          )
          const pgPath = paths.getBinaryPath({
            engine: 'postgresql',
            version: pgFullVersion,
            platform: ferretPlatform,
            arch: ferretArch,
          })
          console.log(chalk.gray(`  PostgreSQL backend location: ${pgPath}`))
        } else {
          const fullDocumentDBVersion = normalizeDocumentDBVersion(
            DEFAULT_DOCUMENTDB_VERSION,
          )
          const documentdbPath = ferretdbBinaryManager.getDocumentDBBinaryPath(
            fullDocumentDBVersion,
            ferretPlatform,
            ferretArch,
          )
          console.log(
            chalk.gray(`  postgresql-documentdb location: ${documentdbPath}`),
          )
        }

        // Skip client tools check - FerretDB uses MongoDB client tools (mongosh)
        // which are installed separately via: spindb engines download mongodb
        console.log(
          chalk.gray(
            '  Note: Use mongosh to connect (install via: spindb engines download mongodb)',
          ),
        )
        return
      }

      if (['couchdb', 'couch'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('CouchDB requires a version (e.g., 3)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.CouchDB)

        const spinner = createSpinner(`Checking CouchDB ${version} binaries...`)
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `CouchDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`CouchDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`CouchDB ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: couchdbPlatform, arch: couchdbArch } =
          platformService.getPlatformInfo()
        const couchdbFullVersion = couchdbBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'couchdb',
          version: couchdbFullVersion,
          platform: couchdbPlatform,
          arch: couchdbArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Skip client tools check for CouchDB - it's a REST API server
        // with no CLI client tools (uses HTTP protocols instead)
        return
      }

      if (['cockroachdb', 'crdb'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('CockroachDB requires a version (e.g., 25)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.CockroachDB)

        const spinner = createSpinner(
          `Checking CockroachDB ${version} binaries...`,
        )
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `CockroachDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`CockroachDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`CockroachDB ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: cockroachdbPlatform, arch: cockroachdbArch } =
          platformService.getPlatformInfo()
        const cockroachdbFullVersion =
          cockroachdbBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'cockroachdb',
          version: cockroachdbFullVersion,
          platform: cockroachdbPlatform,
          arch: cockroachdbArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Skip client tools check for CockroachDB - the cockroach binary is both server and client
        return
      }

      if (['surrealdb', 'surreal'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('SurrealDB requires a version (e.g., 2)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.SurrealDB)

        const spinner = createSpinner(
          `Checking SurrealDB ${version} binaries...`,
        )
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `SurrealDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`SurrealDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`SurrealDB ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: surrealdbPlatform, arch: surrealdbArch } =
          platformService.getPlatformInfo()
        const surrealdbFullVersion =
          surrealdbBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'surrealdb',
          version: surrealdbFullVersion,
          platform: surrealdbPlatform,
          arch: surrealdbArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Skip client tools check for SurrealDB - the surreal binary is both server and client
        return
      }

      if (['questdb', 'quest'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('QuestDB requires a version (e.g., 9)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.QuestDB)

        const spinner = createSpinner(`Checking QuestDB ${version} binaries...`)
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `QuestDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`QuestDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`QuestDB ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: questdbPlatform, arch: questdbArch } =
          platformService.getPlatformInfo()
        const questdbFullVersion = questdbBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'questdb',
          version: questdbFullVersion,
          platform: questdbPlatform,
          arch: questdbArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Skip client tools check for QuestDB - uses psql or Web Console
        return
      }

      if (['typedb', 'tdb'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('TypeDB requires a version (e.g., 3)'))
          process.exit(1)
        }

        const { platform, arch } = platformService.getPlatformInfo()
        const platformKey = `${platform}-${arch}`
        const supportedPlatforms = new Set([
          'darwin-x64',
          'darwin-arm64',
          'linux-x64',
          'linux-arm64',
          'win32-x64',
        ])
        if (!supportedPlatforms.has(platformKey)) {
          console.error(
            uiError(
              `TypeDB binaries are not available for ${platformKey}. Supported: darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64.`,
            ),
          )
          process.exit(1)
        }

        const engine = getEngine(Engine.TypeDB)

        const spinner = createSpinner(`Checking TypeDB ${version} binaries...`)
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `TypeDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`TypeDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`TypeDB ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: typedbPlatform, arch: typedbArch } =
          platformService.getPlatformInfo()
        const typedbFullVersion = typedbBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'typedb',
          version: typedbFullVersion,
          platform: typedbPlatform,
          arch: typedbArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Skip client tools check - TypeDB console is bundled
        return
      }

      if (['influxdb', 'influx'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('InfluxDB requires a version (e.g., 3)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.InfluxDB)

        const spinner = createSpinner(
          `Checking InfluxDB ${version} binaries...`,
        )
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `InfluxDB ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`InfluxDB ${version} binaries already installed`)
        } else {
          spinner.succeed(`InfluxDB ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: influxdbPlatform, arch: influxdbArch } =
          platformService.getPlatformInfo()
        const influxdbFullVersion =
          influxdbBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'influxdb',
          version: influxdbFullVersion,
          platform: influxdbPlatform,
          arch: influxdbArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Skip client tools check for InfluxDB - it's a REST API server
        // with no CLI client tools (uses HTTP protocols instead)
        return
      }

      if (['weaviate', 'wv'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('Weaviate requires a version (e.g., 1)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.Weaviate)

        const spinner = createSpinner(
          `Checking Weaviate ${version} binaries...`,
        )
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `Weaviate ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`Weaviate ${version} binaries already installed`)
        } else {
          spinner.succeed(`Weaviate ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: weaviatePlatform, arch: weaviateArch } =
          platformService.getPlatformInfo()
        const weaviateFullVersion =
          weaviateBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'weaviate',
          version: weaviateFullVersion,
          platform: weaviatePlatform,
          arch: weaviateArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        // Skip client tools check for Weaviate - it's a REST API server
        // with no CLI client tools (uses HTTP protocols instead)
        return
      }

      if (['tigerbeetle', 'tb'].includes(normalizedEngine)) {
        if (!version) {
          console.error(uiError('TigerBeetle requires a version (e.g., 0.16)'))
          process.exit(1)
        }

        const engine = getEngine(Engine.TigerBeetle)

        const spinner = createSpinner(
          `Checking TigerBeetle ${version} binaries...`,
        )
        spinner.start()

        let wasCached = false
        await engine.ensureBinaries(version, ({ stage, message }) => {
          if (stage === 'cached') {
            wasCached = true
            spinner.text = `TigerBeetle ${version} binaries ready (cached)`
          } else {
            spinner.text = message
          }
        })

        if (wasCached) {
          spinner.succeed(`TigerBeetle ${version} binaries already installed`)
        } else {
          spinner.succeed(`TigerBeetle ${version} binaries downloaded`)
        }

        // Show the path for reference
        const { platform: tbPlatform, arch: tbArch } =
          platformService.getPlatformInfo()
        const tbFullVersion = tigerbeetleBinaryManager.getFullVersion(version)
        const binPath = paths.getBinaryPath({
          engine: 'tigerbeetle',
          version: tbFullVersion,
          platform: tbPlatform,
          arch: tbArch,
        })
        console.log(chalk.gray(`  Location: ${binPath}`))

        return
      }

      console.error(
        uiError(
          `Unknown engine "${engineName}". Supported: ${ALL_ENGINES.join(', ')}`,
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
      const rawData = await loadEnginesJson()
      const { platform, arch } = platformService.getPlatformInfo()
      const platformKey = `${platform}-${arch}`
      const enginesData = filterEnginesByPlatform(rawData, platformKey)

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
