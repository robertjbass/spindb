import { program } from 'commander'
import { createRequire } from 'module'
import chalk from 'chalk'
import { createCommand } from './commands/create'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }
import { listCommand } from './commands/list'
import { startCommand } from './commands/start'
import { stopCommand } from './commands/stop'
import { deleteCommand } from './commands/delete'
import { restoreCommand } from './commands/restore'
import { backupCommand } from './commands/backup'
import { connectCommand } from './commands/connect'
import { cloneCommand } from './commands/clone'
import { menuCommand } from './commands/menu'
import { configCommand } from './commands/config'
import { depsCommand } from './commands/deps'
import { enginesCommand } from './commands/engines'
import { editCommand } from './commands/edit'
import { urlCommand } from './commands/url'
import { infoCommand } from './commands/info'
import { selfUpdateCommand } from './commands/self-update'
import { versionCommand } from './commands/version'
import { runCommand } from './commands/run'
import { logsCommand } from './commands/logs'
import { doctorCommand } from './commands/doctor'
import { attachCommand } from './commands/attach'
import { detachCommand } from './commands/detach'
import { sqliteCommand } from './commands/sqlite'
import { updateManager } from '../core/update-manager'

/**
 * Show update notification banner if an update is available (from cached data)
 * This shows on every run until the user updates or disables checks
 */
async function showUpdateNotificationIfAvailable(): Promise<void> {
  try {
    const cached = await updateManager.getCachedUpdateInfo()

    // Skip if auto-check is disabled or no cached version
    if (!cached.autoCheckEnabled || !cached.latestVersion) return

    const currentVersion = updateManager.getCurrentVersion()
    const latestVersion = cached.latestVersion

    // Skip if no update available
    if (updateManager.compareVersions(latestVersion, currentVersion) <= 0)
      return

    // Show notification banner
    console.log()
    console.log(chalk.cyan('┌' + '─'.repeat(52) + '┐'))
    console.log(
      chalk.cyan('│') +
        chalk.yellow(' Update available! ') +
        chalk.gray(`${currentVersion} -> `) +
        chalk.green(latestVersion) +
        ' '.repeat(
          Math.max(
            0,
            52 - 21 - currentVersion.length - 4 - latestVersion.length,
          ),
        ) +
        chalk.cyan('│'),
    )
    console.log(
      chalk.cyan('│') +
        chalk.gray(' Run: ') +
        chalk.cyan('spindb self-update') +
        ' '.repeat(28) +
        chalk.cyan('│'),
    )
    console.log(
      chalk.cyan('│') +
        chalk.gray(' To disable: ') +
        chalk.gray('spindb config update-check off') +
        ' '.repeat(8) +
        chalk.cyan('│'),
    )
    console.log(chalk.cyan('└' + '─'.repeat(52) + '┘'))
    console.log()
  } catch {
    // Silently ignore errors - update notification is not critical
  }
}

/**
 * Trigger background update check (fire and forget)
 * This updates the cache for the next run's notification
 */
function triggerBackgroundUpdateCheck(): void {
  updateManager.checkForUpdate(false).catch(() => {
    // Silently ignore - background check is best-effort
  })
}

export async function run(): Promise<void> {
  // Trigger background update check (non-blocking, updates cache for next run)
  triggerBackgroundUpdateCheck()

  // Show update notification if an update is available (from cached data)
  await showUpdateNotificationIfAvailable()

  program
    .name('spindb')
    .description('Spin up local database containers without Docker')
    .version(pkg.version, '-v, --version', 'output the version number')

  program.addCommand(createCommand)
  program.addCommand(listCommand)
  program.addCommand(startCommand)
  program.addCommand(stopCommand)
  program.addCommand(deleteCommand)
  program.addCommand(restoreCommand)
  program.addCommand(backupCommand)
  program.addCommand(connectCommand)
  program.addCommand(cloneCommand)
  program.addCommand(menuCommand)
  program.addCommand(configCommand)
  program.addCommand(depsCommand)
  program.addCommand(enginesCommand)
  program.addCommand(editCommand)
  program.addCommand(urlCommand)
  program.addCommand(infoCommand)
  program.addCommand(selfUpdateCommand)
  program.addCommand(versionCommand)
  program.addCommand(runCommand)
  program.addCommand(logsCommand)
  program.addCommand(doctorCommand)
  program.addCommand(attachCommand)
  program.addCommand(detachCommand)
  program.addCommand(sqliteCommand)

  // If no arguments provided, show interactive menu
  if (process.argv.length <= 2) {
    await menuCommand.parseAsync([])
    return
  }

  program.parse()
}
