/**
 * Doctor command - System health checks and diagnostics
 *
 * Checks:
 * 1. Configuration file validity
 * 2. Container status across all engines
 * 3. SQLite registry orphaned entries
 * 4. Binary/tool availability
 */

import { Command } from 'commander'
import { existsSync } from 'fs'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { configManager } from '../../core/config-manager'
import { sqliteRegistry } from '../../engines/sqlite/registry'
import { paths } from '../../config/paths'
import { getSupportedEngines } from '../../config/engine-defaults'
import { checkEngineDependencies } from '../../core/dependency-manager'
import { header, uiSuccess } from '../ui/theme'
import { Engine } from '../../types'

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

/**
 * Check configuration file validity
 */
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

/**
 * Check container status across all engines
 */
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

/**
 * Check SQLite registry for orphaned entries
 */
async function checkSqliteRegistry(): Promise<HealthCheckResult> {
  try {
    const entries = await sqliteRegistry.list()

    if (entries.length === 0) {
      return {
        name: 'SQLite Registry',
        status: 'ok',
        message: 'No SQLite databases registered',
      }
    }

    const orphans = await sqliteRegistry.findOrphans()

    if (orphans.length > 0) {
      return {
        name: 'SQLite Registry',
        status: 'warning',
        message: `${orphans.length} orphaned entr${orphans.length === 1 ? 'y' : 'ies'} found`,
        details: orphans.map((o) => `"${o.name}" → ${o.filePath}`),
        action: {
          label: 'Remove orphaned entries from registry',
          handler: async () => {
            const count = await sqliteRegistry.removeOrphans()
            console.log(uiSuccess(`Removed ${count} orphaned entries`))
          },
        },
      }
    }

    return {
      name: 'SQLite Registry',
      status: 'ok',
      message: `${entries.length} database(s) registered, all files exist`,
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

/**
 * Check binary/tool availability for all engines
 */
async function checkBinaries(): Promise<HealthCheckResult> {
  try {
    const engines = getSupportedEngines()
    const results: string[] = []
    let hasWarning = false

    for (const engine of engines) {
      const statuses = await checkEngineDependencies(engine)
      const installed = statuses.filter((s) => s.installed).length
      const total = statuses.length

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

/**
 * Display a single health check result
 */
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
  .action(async (options: { json?: boolean }) => {
    const checks = [
      await checkConfiguration(),
      await checkContainers(),
      await checkSqliteRegistry(),
      await checkBinaries(),
    ]

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

    // Collect actions for warnings
    const actionsAvailable = checks.filter((c) => c.action)

    if (actionsAvailable.length > 0) {
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
      }
    }

    console.log()
  })
