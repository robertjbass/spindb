import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { containerManager } from '../../../core/container-manager'
import {
  promptInstallDependencies,
  enableGlobalEscape,
  checkAndResetEscape,
  escapeablePrompt,
  EscapeError,
} from '../../ui/prompts'
import { header, uiError } from '../../ui/theme'
import { MissingToolError } from '../../../core/error-handler'
import { hasAnyInstalledEngines } from '../../helpers'
import {
  handleCreate,
  handleList,
  handleStart,
  handleStop,
} from './container-handlers'
import { handleBackup, handleRestore, handleClone } from './backup-handlers'
import { handleEngines } from './engine-handlers'
import { handleCheckUpdate, handleDoctor } from './update-handlers'
import { type MenuChoice } from './shared'

async function showMainMenu(): Promise<void> {
  console.clear()
  console.log(header('SpinDB - Local Database Manager'))
  console.log()

  // Parallelize container list and engine checks for faster startup
  const [containers, hasEngines] = await Promise.all([
    containerManager.list(),
    hasAnyInstalledEngines(),
  ])

  const running = containers.filter((c) => c.status === 'running').length
  const stopped = containers.filter((c) => c.status !== 'running').length

  console.log(
    chalk.gray(
      `  ${containers.length} container(s): ${running} running, ${stopped} stopped`,
    ),
  )
  console.log()

  const canStart = stopped > 0
  const canStop = running > 0
  const canRestore = running > 0
  const canClone = containers.length > 0

  // If containers exist, show List first; otherwise show Create first
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
    {
      name: canStart
        ? `${chalk.green('▶')} Start container`
        : chalk.gray('▶ Start container'),
      value: 'start',
      disabled: canStart ? false : 'No stopped containers',
    },
    {
      name: canStop
        ? `${chalk.red('■')} Stop container`
        : chalk.gray('■ Stop container'),
      value: 'stop',
      disabled: canStop ? false : 'No running containers',
    },
    {
      name: canRestore
        ? `${chalk.magenta('↓')} Backup database`
        : chalk.gray('↓ Backup database'),
      value: 'backup',
      disabled: canRestore ? false : 'No running containers',
    },
    {
      name: canRestore
        ? `${chalk.magenta('↑')} Restore backup`
        : chalk.gray('↑ Restore backup'),
      value: 'restore',
      disabled: canRestore ? false : 'No running containers',
    },
    {
      name: canClone
        ? `${chalk.cyan('◇')} Clone container`
        : chalk.gray('◇ Clone container'),
      value: 'clone',
      disabled: canClone ? false : 'No containers',
    },
    new inquirer.Separator(),
    {
      name: hasEngines
        ? `${chalk.yellow('⚙')} Manage engines`
        : chalk.gray('⚙ Manage engines'),
      value: 'engines',
      disabled: hasEngines ? false : 'No engines installed',
    },
    { name: `${chalk.red.bold('+')} Health check`, value: 'doctor' },
    { name: `${chalk.cyan('↑')} Check for updates`, value: 'check-update' },
    { name: `${chalk.gray('⏻')} Exit`, value: 'exit' },
  ]

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices,
      pageSize: 12,
    },
  ])

  switch (action) {
    case 'create':
      await handleCreate()
      break
    case 'list':
      await handleList(showMainMenu)
      break
    case 'start':
      await handleStart()
      break
    case 'stop':
      await handleStop()
      break
    case 'restore':
      await handleRestore()
      break
    case 'backup':
      await handleBackup()
      break
    case 'clone':
      await handleClone()
      break
    case 'engines':
      await handleEngines()
      break
    case 'doctor':
      await handleDoctor()
      break
    case 'check-update':
      await handleCheckUpdate()
      break
    case 'exit':
      console.log(chalk.gray('\n  Goodbye!\n'))
      process.exit(0)
  }

  await showMainMenu()
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
