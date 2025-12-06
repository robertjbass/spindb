import { existsSync } from 'fs'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { updateManager } from '../../../core/update-manager'
import { containerManager } from '../../../core/container-manager'
import { configManager } from '../../../core/config-manager'
import { sqliteRegistry } from '../../../engines/sqlite/registry'
import { paths } from '../../../config/paths'
import { getSupportedEngines } from '../../../config/engine-defaults'
import { checkEngineDependencies } from '../../../core/dependency-manager'
import { createSpinner } from '../../ui/spinner'
import { header, success, error, warning, info } from '../../ui/theme'
import { pressEnterToContinue } from './shared'
import { Engine } from '../../../types'

export async function handleCheckUpdate(): Promise<void> {
  console.clear()
  console.log(header('Check for Updates'))
  console.log()

  const spinner = createSpinner('Checking for updates...')
  spinner.start()

  const result = await updateManager.checkForUpdate(true)

  if (!result) {
    spinner.fail('Could not reach npm registry')
    console.log()
    console.log(info('Check your internet connection and try again.'))
    console.log(chalk.gray('  Manual update: npm install -g spindb@latest'))
    console.log()
    await pressEnterToContinue()
    return
  }

  if (result.updateAvailable) {
    spinner.succeed('Update available')
    console.log()
    console.log(chalk.gray(`  Current version: ${result.currentVersion}`))
    console.log(
      chalk.gray(`  Latest version:  ${chalk.green(result.latestVersion)}`),
    )
    console.log()

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Update now', value: 'update' },
          { name: 'Remind me later', value: 'later' },
          { name: "Don't check for updates on startup", value: 'disable' },
        ],
      },
    ])

    if (action === 'update') {
      console.log()
      const updateSpinner = createSpinner('Updating spindb...')
      updateSpinner.start()

      const updateResult = await updateManager.performUpdate()

      if (updateResult.success) {
        updateSpinner.succeed('Update complete')
        console.log()
        console.log(
          success(
            `Updated from ${updateResult.previousVersion} to ${updateResult.newVersion}`,
          ),
        )
        console.log()
        if (updateResult.previousVersion !== updateResult.newVersion) {
          console.log(warning('Please restart spindb to use the new version.'))
          console.log()
        }
      } else {
        updateSpinner.fail('Update failed')
        console.log()
        console.log(error(updateResult.error || 'Unknown error'))
        console.log()
        console.log(info('Manual update: npm install -g spindb@latest'))
      }
      await pressEnterToContinue()
    } else if (action === 'disable') {
      await updateManager.setAutoCheckEnabled(false)
      console.log()
      console.log(info('Update checks disabled on startup.'))
      console.log(chalk.gray('  Re-enable with: spindb config update-check on'))
      console.log()
      await pressEnterToContinue()
    }
    // 'later' just returns to menu
  } else {
    spinner.succeed('You are on the latest version')
    console.log()
    console.log(chalk.gray(`  Version: ${result.currentVersion}`))
    console.log()
    await pressEnterToContinue()
  }
}

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
            console.log(success('Binary cache refreshed'))
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
  } catch (err) {
    return {
      name: 'Configuration',
      status: 'error',
      message: 'Configuration file is corrupted',
      details: [(err as Error).message],
    }
  }
}

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
  } catch (err) {
    return {
      name: 'Containers',
      status: 'error',
      message: 'Failed to list containers',
      details: [(err as Error).message],
    }
  }
}

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
            console.log(success(`Removed ${count} orphaned entries`))
          },
        },
      }
    }

    return {
      name: 'SQLite Registry',
      status: 'ok',
      message: `${entries.length} database(s) registered, all files exist`,
    }
  } catch (err) {
    return {
      name: 'SQLite Registry',
      status: 'warning',
      message: 'Could not check registry',
      details: [(err as Error).message],
    }
  }
}

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
  } catch (err) {
    return {
      name: 'Database Tools',
      status: 'error',
      message: 'Failed to check tools',
      details: [(err as Error).message],
    }
  }
}

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

export async function handleDoctor(): Promise<void> {
  console.clear()
  console.log(header('SpinDB Health Check'))
  console.log()

  const checks = [
    await checkConfiguration(),
    await checkContainers(),
    await checkSqliteRegistry(),
    await checkBinaries(),
  ]

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

    if (selectedAction !== 'skip') {
      const check = checks.find((c) => c.name === selectedAction)
      if (check?.action) {
        console.log()
        await check.action.handler()
      }
    }
  } else {
    const hasIssues = checks.some((c) => c.status !== 'ok')
    if (!hasIssues) {
      console.log(chalk.green('All systems healthy! ✓'))
    }
  }

  console.log()
  await pressEnterToContinue()
}
