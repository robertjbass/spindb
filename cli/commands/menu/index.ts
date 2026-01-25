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
          { name: `${chalk.green('+')} Create new container`, value: 'create' },
        ]
      : [
          { name: `${chalk.green('+')} Create new container`, value: 'create' },
          { name: `${chalk.cyan('◉')} Containers`, value: 'list' },
        ]),
    {
      name: canStart
        ? `${chalk.green('▶')} Start a container`
        : chalk.gray('▶ Start a container'),
      value: 'start',
      disabled: canStart ? false : 'No stopped containers',
    },
    {
      name: canStop
        ? `${chalk.red('■')} Stop a container`
        : chalk.gray('■ Stop a container'),
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
        ? `${chalk.cyan('⧉')} Clone a container`
        : chalk.gray('⧉ Clone a container'),
      value: 'clone',
      disabled: canClone ? false : 'No containers',
    },
    new inquirer.Separator(),
    {
      name: hasEngines
        ? `${chalk.yellow('⚙')} Manage installed engines`
        : chalk.gray('⚙ Manage installed engines'),
      value: 'engines',
      disabled: hasEngines ? false : 'No engines installed',
    },
    { name: `${chalk.bgRed.white('+')} System health check`, value: 'doctor' },
    { name: `${chalk.cyan('↑')} Check for updates`, value: 'check-update' },
    { name: `${chalk.gray('⏻')} Exit ${chalk.gray('(ctrl+c)')}`, value: 'exit' },
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

        // Check if this is a missing tool error
        if (
          e.message.includes('pg_restore not found') ||
          e.message.includes('psql not found') ||
          e.message.includes('pg_dump not found')
        ) {
          const missingTool = e.message.includes('pg_restore')
            ? 'pg_restore'
            : e.message.includes('pg_dump')
              ? 'pg_dump'
              : 'psql'
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
