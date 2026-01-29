/**
 * Doctor command - System health checks and diagnostics
 *
 * Checks:
 * 1. Configuration file validity
 * 2. User preferences (icon mode)
 * 3. Container status across all engines
 * 4. SQLite registry orphaned entries
 * 5. DuckDB registry orphaned entries
 * 6. Binary/tool availability
 * 7. Version migration (outdated container versions)
 * 8. Orphaned test containers cleanup
 */

import { Command } from 'commander'
import { existsSync } from 'fs'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { configManager } from '../../core/config-manager'
import { sqliteRegistry } from '../../engines/sqlite/registry'
import { duckdbRegistry } from '../../engines/duckdb/registry'
import { paths } from '../../config/paths'
import { getSupportedEngines } from '../../config/engine-defaults'
import { checkEngineDependencies } from '../../core/dependency-manager'
import { header, uiSuccess } from '../ui/theme'
import { Engine } from '../../types'
import {
  findOutdatedContainers,
  migrateContainerVersion,
  deleteOldBinaryIfUnused,
  type OutdatedContainer,
} from '../../core/version-migration'
import {
  findOrphanedTestContainers,
  deleteTestContainer,
} from '../../core/test-cleanup'

type HealthCheckResult = {
  name: string
  status: 'ok' | 'warning' | 'error'
  message: string
  details?: string[]
  action?: {
    label: string
    handler: () => Promise<void>
  }
}

// Check configuration file validity
async function checkConfiguration(): Promise<HealthCheckResult> {
  const configPath = paths.config

  if (!existsSync(configPath)) {
    return {
      name: 'Configuration',
      status: 'ok',
      message: 'No config file yet (will be created on first use)',
    }
  }

  try {
    const config = await configManager.load()
    const binaryCount = Object.keys(config.binaries || {}).length
    const isStale = await configManager.isStale()

    if (isStale) {
      return {
        name: 'Configuration',
        status: 'warning',
        message: 'Binary cache is stale (>7 days old)',
        details: [`Binary tools cached: ${binaryCount}`],
        action: {
          label: 'Refresh binary cache',
          handler: async () => {
            await configManager.refreshAllBinaries()
            console.log(uiSuccess('Binary cache refreshed'))
          },
        },
      }
    }

    return {
      name: 'Configuration',
      status: 'ok',
      message: 'Configuration valid',
      details: [`Binary tools cached: ${binaryCount}`],
    }
  } catch (error) {
    return {
      name: 'Configuration',
      status: 'error',
      message: 'Configuration file is corrupted',
      details: [(error as Error).message],
    }
  }
}

// Check user preferences (icon mode, etc.)
async function checkPreferences(): Promise<HealthCheckResult> {
  const configPath = paths.config

  if (!existsSync(configPath)) {
    return {
      name: 'Preferences',
      status: 'ok',
      message: 'No config file yet (preferences will use defaults)',
    }
  }

  try {
    const config = await configManager.load()

    // Check if preferences.iconMode is set
    if (!config.preferences?.iconMode) {
      return {
        name: 'Preferences',
        status: 'warning',
        message: 'Icon mode not configured (defaulting to ascii)',
        details: ['Run: spindb config icons to set your preference'],
        action: {
          label: 'Set icon mode to ascii (default)',
          handler: async () => {
            const currentConfig = await configManager.load()
            currentConfig.preferences = {
              ...currentConfig.preferences,
              iconMode: 'ascii',
            }
            await configManager.save()
            console.log(uiSuccess('Icon mode set to ascii'))
          },
        },
      }
    }

    return {
      name: 'Preferences',
      status: 'ok',
      message: `Icon mode: ${config.preferences.iconMode}`,
    }
  } catch (error) {
    return {
      name: 'Preferences',
      status: 'error',
      message: 'Failed to check preferences',
      details: [(error as Error).message],
    }
  }
}

// Check container status across all engines
async function checkContainers(): Promise<HealthCheckResult> {
  try {
    const containers = await containerManager.list()

    if (containers.length === 0) {
      return {
        name: 'Containers',
        status: 'ok',
        message: 'No containers (create one with: spindb create)',
      }
    }

    const byEngine: Record<string, { running: number; stopped: number }> = {}

    for (const c of containers) {
      const engineName = c.engine
      if (!byEngine[engineName]) {
        byEngine[engineName] = { running: 0, stopped: 0 }
      }
      if (c.status === 'running') {
        byEngine[engineName].running++
      } else {
        byEngine[engineName].stopped++
      }
    }

    const details = Object.entries(byEngine).map(([engine, counts]) => {
      if (engine === Engine.SQLite) {
        return `${engine}: ${counts.running} exist, ${counts.stopped} missing`
      }
      return `${engine}: ${counts.running} running, ${counts.stopped} stopped`
    })

    return {
      name: 'Containers',
      status: 'ok',
      message: `${containers.length} container(s)`,
      details,
    }
  } catch (error) {
    return {
      name: 'Containers',
      status: 'error',
      message: 'Failed to list containers',
      details: [(error as Error).message],
    }
  }
}

// Check SQLite registry for orphaned entries
async function checkSqliteRegistry(): Promise<HealthCheckResult> {
  try {
    const entries = await sqliteRegistry.list()
    const ignoredFolders = await sqliteRegistry.listIgnoredFolders()

    if (entries.length === 0 && ignoredFolders.length === 0) {
      return {
        name: 'SQLite Registry',
        status: 'ok',
        message: 'No SQLite databases registered',
      }
    }

    const orphans = await sqliteRegistry.findOrphans()

    if (orphans.length > 0) {
      const details = [
        ...orphans.map((o) => `"${o.name}" → ${o.filePath}`),
        ...(ignoredFolders.length > 0
          ? [`${ignoredFolders.length} folder(s) ignored`]
          : []),
      ]

      return {
        name: 'SQLite Registry',
        status: 'warning',
        message: `${orphans.length} orphaned entr${orphans.length === 1 ? 'y' : 'ies'} found`,
        details,
        action: {
          label: 'Remove orphaned entries from registry',
          handler: async () => {
            const count = await sqliteRegistry.removeOrphans()
            console.log(uiSuccess(`Removed ${count} orphaned entries`))
          },
        },
      }
    }

    const details = [
      `${entries.length} database(s) registered, all files exist`,
    ]
    if (ignoredFolders.length > 0) {
      details.push(`${ignoredFolders.length} folder(s) ignored`)
    }

    return {
      name: 'SQLite Registry',
      status: 'ok',
      message: `${entries.length} database(s) registered, all files exist`,
      details: ignoredFolders.length > 0 ? details : undefined,
    }
  } catch (error) {
    return {
      name: 'SQLite Registry',
      status: 'warning',
      message: 'Could not check registry',
      details: [(error as Error).message],
    }
  }
}

// Check DuckDB registry for orphaned entries
async function checkDuckdbRegistry(): Promise<HealthCheckResult> {
  try {
    const entries = await duckdbRegistry.list()
    const ignoredFolders = await duckdbRegistry.listIgnoredFolders()

    if (entries.length === 0 && ignoredFolders.length === 0) {
      return {
        name: 'DuckDB Registry',
        status: 'ok',
        message: 'No DuckDB databases registered',
      }
    }

    const orphans = await duckdbRegistry.findOrphans()

    if (orphans.length > 0) {
      const details = [
        ...orphans.map((o) => `"${o.name}" → ${o.filePath}`),
        ...(ignoredFolders.length > 0
          ? [`${ignoredFolders.length} folder(s) ignored`]
          : []),
      ]

      return {
        name: 'DuckDB Registry',
        status: 'warning',
        message: `${orphans.length} orphaned entr${orphans.length === 1 ? 'y' : 'ies'} found`,
        details,
        action: {
          label: 'Remove orphaned DuckDB entries from registry',
          handler: async () => {
            const count = await duckdbRegistry.removeOrphans()
            console.log(uiSuccess(`Removed ${count} orphaned DuckDB entries`))
          },
        },
      }
    }

    const details = [
      `${entries.length} database(s) registered, all files exist`,
    ]
    if (ignoredFolders.length > 0) {
      details.push(`${ignoredFolders.length} folder(s) ignored`)
    }

    return {
      name: 'DuckDB Registry',
      status: 'ok',
      message: `${entries.length} database(s) registered, all files exist`,
      details: ignoredFolders.length > 0 ? details : undefined,
    }
  } catch (error) {
    return {
      name: 'DuckDB Registry',
      status: 'warning',
      message: 'Could not check registry',
      details: [(error as Error).message],
    }
  }
}

// Check binary/tool availability for all engines
async function checkBinaries(): Promise<HealthCheckResult> {
  try {
    const engines = getSupportedEngines()

    // Run all engine checks in parallel for better performance (especially on Windows)
    const engineChecks = await Promise.all(
      engines.map(async (engine) => {
        const statuses = await checkEngineDependencies(engine)
        const installed = statuses.filter((s) => s.installed).length
        const total = statuses.length
        return { engine, installed, total }
      }),
    )

    const results: string[] = []
    let hasWarning = false

    for (const { engine, installed, total } of engineChecks) {
      if (installed < total) {
        hasWarning = true
        results.push(`${engine}: ${installed}/${total} tools installed`)
      } else {
        results.push(`${engine}: all ${total} tools available`)
      }
    }

    return {
      name: 'Database Tools',
      status: hasWarning ? 'warning' : 'ok',
      message: hasWarning ? 'Some tools missing' : 'All tools available',
      details: results,
    }
  } catch (error) {
    return {
      name: 'Database Tools',
      status: 'error',
      message: 'Failed to check tools',
      details: [(error as Error).message],
    }
  }
}

// Check for containers with outdated versions
async function checkVersionMigration(
  dryRun: boolean,
): Promise<HealthCheckResult> {
  try {
    const outdated = await findOutdatedContainers()

    if (outdated.length === 0) {
      return {
        name: 'Version Migration',
        status: 'ok',
        message: 'All container versions are current',
      }
    }

    // Group by container to avoid duplicate entries for FerretDB (version + backendVersion)
    const containerMigrations = new Map<string, OutdatedContainer[]>()
    for (const item of outdated) {
      const key = item.container.name
      if (!containerMigrations.has(key)) {
        containerMigrations.set(key, [])
      }
      containerMigrations.get(key)!.push(item)
    }

    const details: string[] = dryRun ? ['DRY RUN - no changes made'] : []

    for (const [name, migrations] of containerMigrations) {
      for (const m of migrations) {
        const fieldLabel = m.field === 'backendVersion' ? ' (backend)' : ''
        details.push(
          `${name}${fieldLabel}: ${m.currentVersion} → ${m.targetVersion}`,
        )
      }
    }

    if (dryRun) {
      return {
        name: 'Version Migration',
        status: 'warning',
        message: `${containerMigrations.size} container(s) need version migration`,
        details,
      }
    }

    return {
      name: 'Version Migration',
      status: 'warning',
      message: `${containerMigrations.size} container(s) need version migration`,
      details,
      action: {
        label: 'Migrate container versions',
        handler: async () => {
          const deletedBinaries: string[] = []

          for (const item of outdated) {
            await migrateContainerVersion(
              item.container.name,
              item.targetVersion,
              item.field,
            )
            const fieldLabel =
              item.field === 'backendVersion' ? ' (backend)' : ''
            console.log(
              uiSuccess(
                `Migrated ${item.container.name}${fieldLabel}: ${item.currentVersion} → ${item.targetVersion}`,
              ),
            )

            // Delete old binary if no other containers use it
            const engine =
              item.field === 'backendVersion'
                ? 'postgresql-documentdb'
                : item.container.engine
            const deleted = await deleteOldBinaryIfUnused(
              engine,
              item.currentVersion,
            )
            if (deleted) {
              deletedBinaries.push(`${engine}-${item.currentVersion}`)
            }
          }

          console.log(uiSuccess(`Migrated ${outdated.length} version(s)`))
          if (deletedBinaries.length > 0) {
            console.log(
              uiSuccess(
                `Removed ${deletedBinaries.length} unused binary(ies): ${deletedBinaries.join(', ')}`,
              ),
            )
          }
        },
      },
    }
  } catch (error) {
    return {
      name: 'Version Migration',
      status: 'error',
      message: 'Failed to check container versions',
      details: [(error as Error).message],
    }
  }
}

// Check for orphaned test containers (scans filesystem directly)
async function checkOrphanedTestContainers(
  dryRun: boolean,
): Promise<HealthCheckResult> {
  try {
    const testDirs = await findOrphanedTestContainers()

    if (testDirs.length === 0) {
      return {
        name: 'Test Containers',
        status: 'ok',
        message: 'No orphaned test containers found',
      }
    }

    const details = dryRun ? ['DRY RUN - no changes made'] : []
    details.push(...testDirs.map((d) => `${d.engine}/${d.name}`))

    if (dryRun) {
      return {
        name: 'Test Containers',
        status: 'warning',
        message: `${testDirs.length} orphaned test container(s) found`,
        details,
      }
    }

    return {
      name: 'Test Containers',
      status: 'warning',
      message: `${testDirs.length} orphaned test container(s) found`,
      details,
      action: {
        label: 'Delete orphaned test containers',
        handler: async () => {
          for (const d of testDirs) {
            await deleteTestContainer(d)
            console.log(uiSuccess(`Deleted ${d.engine}/${d.name}`))
          }
          console.log(uiSuccess(`Deleted ${testDirs.length} test containers`))
        },
      },
    }
  } catch (error) {
    return {
      name: 'Test Containers',
      status: 'error',
      message: 'Failed to check test containers',
      details: [(error as Error).message],
    }
  }
}

// Display a single health check result
function displayResult(result: HealthCheckResult): void {
  const icon =
    result.status === 'ok'
      ? chalk.green('✓')
      : result.status === 'warning'
        ? chalk.yellow('⚠')
        : chalk.red('✕')

  console.log(`${icon} ${chalk.bold(result.name)}`)
  console.log(`  └─ ${result.message}`)

  if (result.details) {
    for (const detail of result.details) {
      console.log(chalk.gray(`     ${detail}`))
    }
  }
  console.log()
}

export const doctorCommand = new Command('doctor')
  .description('Check system health and fix common issues')
  .option('--json', 'Output as JSON')
  .option('--dry-run', 'Show what would be changed without making changes')
  .option('--fix', 'Automatically fix all issues without prompting')
  .action(
    async (options: { json?: boolean; dryRun?: boolean; fix?: boolean }) => {
      const dryRun = options.dryRun ?? false
      const autoFix = options.fix ?? false

      // Run all checks in parallel for better performance
      const checks = await Promise.all([
        checkConfiguration(),
        checkPreferences(),
        checkContainers(),
        checkSqliteRegistry(),
        checkDuckdbRegistry(),
        checkBinaries(),
        checkVersionMigration(dryRun),
        checkOrphanedTestContainers(dryRun),
      ])

      if (options.json) {
        // Strip action handlers for JSON output
        const jsonChecks = checks.map(({ action: _action, ...rest }) => rest)
        console.log(JSON.stringify(jsonChecks, null, 2))
        return
      }

      // Human-readable output - print header first
      console.log()
      console.log(header('SpinDB Health Check'))
      console.log()

      // Display results
      for (const check of checks) {
        displayResult(check)
      }

      // Collect actions for warnings (skip in dry-run mode)
      const actionsAvailable = dryRun ? [] : checks.filter((c) => c.action)

      // Auto-fix mode: run all actions without prompting
      if (autoFix && actionsAvailable.length > 0) {
        console.log()
        const failures: Array<{ name: string; error: Error }> = []

        for (const check of actionsAvailable) {
          try {
            await check.action!.handler()
          } catch (error) {
            const err = error as Error
            failures.push({ name: check.name, error: err })
            console.error(
              chalk.red(
                `  ✕ Auto-fix failed for "${check.name}": ${err.message}`,
              ),
            )
          }
        }

        console.log()

        if (failures.length > 0) {
          console.error(
            chalk.yellow(
              `  ⚠ ${failures.length} auto-fix action(s) failed. See errors above.`,
            ),
          )
          process.exit(1)
        }
        return
      }

      // Detect non-interactive environment (CI, no TTY)
      const isNonInteractive = !!(
        process.env.CI ||
        process.env.GITHUB_ACTIONS ||
        !process.stdin.isTTY
      )

      if (actionsAvailable.length > 0 && !isNonInteractive) {
        type ActionChoice = {
          name: string
          value: string
        }

        const choices: ActionChoice[] = [
          ...actionsAvailable.map((c) => ({
            name: c.action!.label,
            value: c.name,
          })),
          { name: chalk.gray('Skip (do nothing)'), value: 'skip' },
        ]

        const { selectedAction } = await inquirer.prompt<{
          selectedAction: string
        }>([
          {
            type: 'list',
            name: 'selectedAction',
            message: 'What would you like to do?',
            choices,
          },
        ])

        if (selectedAction === 'skip') {
          return
        }

        // Execute the selected action
        const check = checks.find((c) => c.name === selectedAction)
        if (check?.action) {
          console.log()
          await check.action.handler()
        }
      } else {
        const hasIssues = checks.some((c) => c.status !== 'ok')
        if (!hasIssues) {
          console.log(chalk.green('All systems healthy! ✓'))
        } else if (isNonInteractive) {
          // In CI/non-interactive mode, print summary and exit with non-zero code
          const issues = checks.filter((c) => c.status !== 'ok')
          const errors = issues.filter((c) => c.status === 'error')
          const warnings = issues.filter((c) => c.status === 'warning')

          const summary = []
          if (errors.length > 0) {
            summary.push(`${errors.length} error(s)`)
          }
          if (warnings.length > 0) {
            summary.push(`${warnings.length} warning(s)`)
          }

          console.log(chalk.red(`Health check failed: ${summary.join(', ')}`))
          console.log(chalk.yellow(`Run 'spindb doctor --fix' to repair`))
          process.exit(1)
        }
      }

      console.log()
    },
  )
