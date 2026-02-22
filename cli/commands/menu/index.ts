import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { containerManager } from '../../../core/container-manager'
import {
  updateManager,
  type UpdateCheckResult,
} from '../../../core/update-manager'
import {
  promptInstallDependencies,
  enableGlobalEscape,
  checkAndResetEscape,
  escapeablePrompt,
  EscapeError,
} from '../../ui/prompts'
import { header, uiError, uiSuccess, uiWarning } from '../../ui/theme'
import { MissingToolError } from '../../../core/error-handler'
import {
  handleCreate,
  handleList,
  handleLinkRemote,
  showContainerSubmenu,
} from './container-handlers'
import { handleSettings } from './settings-handlers'
import { configManager } from '../../../core/config-manager'
import { createSpinner } from '../../ui/spinner'
import { type MenuChoice, pressEnterToContinue } from './shared'
import { getPageSize, getEngineIcon } from '../../constants'
import { getContainerPorts } from '../ports'

// Track update check state for this session (only check once on first menu load)
let updateCheckPromise: Promise<UpdateCheckResult | null> | null = null
let cachedUpdateResult: UpdateCheckResult | null = null

async function showMainMenu(): Promise<void> {
  console.clear()
  console.log(header('SpinDB - Local Database Manager'))
  console.log()

  // Parallelize container list and config loading for faster startup
  const [containers, config] = await Promise.all([
    containerManager.list(),
    configManager.getConfig(),
  ])

  // Check for updates on first menu load only (if auto-check is enabled)
  // The check runs in background and updates cachedUpdateResult when complete
  const autoCheckEnabled = config.update?.autoCheckEnabled !== false
  if (autoCheckEnabled && !updateCheckPromise) {
    // Start update check in background - it will populate cachedUpdateResult when done
    updateCheckPromise = updateManager
      .checkForUpdate()
      .then((result) => {
        cachedUpdateResult = result
        return result
      })
      .catch(() => null)
  }

  // Check if icon mode preference is set
  const iconModeSet = config.preferences?.iconMode !== undefined

  const running = containers.filter((c) => c.status === 'running').length
  const linked = containers.filter((c) => c.status === 'linked').length
  const stopped = containers.filter(
    (c) => c.status !== 'running' && c.status !== 'linked',
  ).length

  const summaryParts = [`${running} running`, `${stopped} stopped`]
  if (linked > 0) summaryParts.push(`${linked} linked`)
  console.log(
    chalk.gray(
      `  ${containers.length} container(s): ${summaryParts.join(', ')}`,
    ),
  )
  console.log()

  // If containers exist, show Containers first; otherwise show Create first
  const hasContainers = containers.length > 0

  const choices: MenuChoice[] = [
    ...(hasContainers
      ? [
          { name: `${chalk.cyan('◉')} Containers`, value: 'list' },
          { name: `${chalk.green('+')} Create container`, value: 'create' },
        ]
      : [
          { name: `${chalk.green('+')} Create container`, value: 'create' },
          { name: `${chalk.cyan('◉')} Containers`, value: 'list' },
        ]),
    { name: `${chalk.magenta('↔')} Link remote database`, value: 'link' },
    ...(hasContainers
      ? [{ name: `${chalk.magenta('⊞')} Ports`, value: 'ports' }]
      : []),
    new inquirer.Separator(),
    { name: `${chalk.yellow('⚙')} Settings`, value: 'settings' },
    // Show update option if a new version is available (only when auto-check enabled)
    ...(cachedUpdateResult?.updateAvailable
      ? [
          {
            name: `${chalk.green('↑')} Update to v${cachedUpdateResult.latestVersion}`,
            value: 'update',
          },
        ]
      : []),
    { name: `${chalk.gray('⎋')} Exit`, value: 'exit' },
    new inquirer.Separator(),
  ]

  // Show persistent hint below the menu if icon mode is not set (or if PERSISTENT_HINT env var is set)
  const showHint = process.env.PERSISTENT_HINT === 'true' || !iconModeSet
  const hintText =
    process.env.PERSISTENT_HINT_TEXT || 'Tip: Set icon style in Settings'

  // Use BottomBar to show hint below the prompt (including below scroll indicator)
  const bottomBar = showHint ? new inquirer.ui.BottomBar() : null
  if (bottomBar) {
    bottomBar.updateBottomBar(chalk.gray(`  ${hintText}\n`))
  }

  let action: string
  try {
    const result = await escapeablePrompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices,
        pageSize: getPageSize(),
      },
    ])
    action = result.action
  } finally {
    // Clean up the bottom bar
    if (bottomBar) {
      bottomBar.updateBottomBar('')
    }
  }

  switch (action) {
    case 'create': {
      const result = await handleCreate()
      // If a container name is returned, navigate to its submenu
      if (result && result !== 'main') {
        await showContainerSubmenu(result, showMainMenu)
      }
      break
    }
    case 'list':
      await handleList(showMainMenu)
      break
    case 'link':
      await handleLink()
      break
    case 'ports':
      await handlePorts()
      break
    case 'settings':
      await handleSettings()
      break
    case 'update':
      await handleUpdate()
      break
    case 'exit':
      console.log(chalk.gray('\n  Goodbye!\n'))
      process.exit(0)
  }
}

async function handleLink(): Promise<void> {
  const result = await handleLinkRemote()
  if (result) {
    await showContainerSubmenu(result, showMainMenu)
  }
}

async function handlePorts(): Promise<void> {
  console.clear()
  console.log(header('Ports'))
  console.log()

  const containers = await containerManager.list()

  if (containers.length === 0) {
    console.log(chalk.gray('  No containers found.'))
    console.log()
    await pressEnterToContinue()
    return
  }

  const results = await Promise.all(
    containers.map(async (config) => {
      const { status, ports } = await getContainerPorts(config)
      return { config, status, ports }
    }),
  )

  // Only show containers that have ports (skip file-based DBs)
  const withPorts = results.filter((r) => r.ports.length > 0)

  if (withPorts.length === 0) {
    console.log(chalk.gray('  No port-based containers found.'))
    console.log()
    await pressEnterToContinue()
    return
  }

  console.log(
    chalk.gray('  ') +
      chalk.bold.white('NAME'.padEnd(22)) +
      chalk.bold.white('ENGINE'.padEnd(18)) +
      chalk.bold.white('PORT(S)'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(66)))

  for (const { config, status, ports } of withPorts) {
    const engineIcon = getEngineIcon(config.engine)
    const engineName = config.engine.padEnd(13)

    const parts = ports.map((p, i) =>
      i === 0 ? String(p.port) : `${p.port} ${chalk.gray(`(${p.label})`)}`,
    )
    const portDisplay = parts.join(chalk.gray(', '))

    const statusIndicator =
      status === 'running' ? chalk.green('●') : chalk.gray('○')

    console.log(
      chalk.gray('  ') +
        statusIndicator +
        ' ' +
        chalk.cyan(config.name.padEnd(20)) +
        engineIcon +
        chalk.white(engineName) +
        portDisplay,
    )
  }

  console.log()
  await pressEnterToContinue()
}

async function handleUpdate(): Promise<void> {
  console.clear()
  console.log(header('Update SpinDB'))
  console.log()

  if (!cachedUpdateResult) {
    console.log(uiError('No update information available'))
    await pressEnterToContinue()
    return
  }

  console.log(
    chalk.gray(`  Current version: ${cachedUpdateResult.currentVersion}`),
  )
  console.log(
    chalk.gray(
      `  Latest version:  ${chalk.green(cachedUpdateResult.latestVersion)}`,
    ),
  )
  console.log()

  const spinner = createSpinner('Updating spindb...')
  spinner.start()

  const result = await updateManager.performUpdate()

  if (result.success) {
    spinner.succeed('Update complete')
    console.log()
    console.log(
      uiSuccess(
        `Updated from ${result.previousVersion} to ${result.newVersion}`,
      ),
    )
    console.log()
    if (result.previousVersion !== result.newVersion) {
      console.log(uiWarning('Please restart spindb to use the new version.'))
      console.log()
    }
    // Clear cached result so the update option disappears
    cachedUpdateResult = null
    updateCheckPromise = null
  } else {
    spinner.fail('Update failed')
    console.log()
    console.log(uiError(result.error || 'Unknown error'))
    console.log()
    const pm = await updateManager.detectPackageManager()
    console.log(
      chalk.gray(`  Manual update: ${updateManager.getInstallCommand(pm)}`),
    )
  }

  await pressEnterToContinue()
}

export const menuCommand = new Command('menu')
  .description('Interactive menu for managing containers')
  .action(async () => {
    // Enable global escape key handling - pressing escape anywhere returns to main menu
    // This also handles ctrl+c for graceful exit with goodbye message
    enableGlobalEscape()

    // Run menu in a loop so escape can restart it
    while (true) {
      try {
        await showMainMenu()
      } catch (error) {
        const e = error as Error

        // If escape was pressed, just restart the menu
        if (
          error instanceof EscapeError ||
          checkAndResetEscape() ||
          e.message?.includes('prompt was closed')
        ) {
          continue
        }

        // Check if this is a missing tool error (prefer typed error, fallback to string matching)
        let missingTool: string | null = null

        if (error instanceof MissingToolError) {
          missingTool = error.tool
        } else if (e.message) {
          // Fallback for older callers that may throw plain Error with message
          // Use regex to extract tool name from "<tool> not found" pattern
          const toolMatch = e.message.match(/(\w+(?:-\w+)*)\s+not found/i)
          if (toolMatch) {
            missingTool = toolMatch[1]
          }
        }

        if (missingTool) {
          try {
            const installed = await promptInstallDependencies(missingTool)
            if (installed) {
              // Installation succeeded, continue the menu loop so user can retry
              continue
            }
            // Installation failed or was declined
            process.exit(1)
          } catch (installError) {
            // User pressed Escape during install prompt - treat as declined
            if (
              installError instanceof EscapeError ||
              (installError as Error).message?.includes('prompt was closed')
            ) {
              continue
            }
            throw installError
          }
        }

        console.error(uiError(e.message))
        process.exit(1)
      }
    }
  })
