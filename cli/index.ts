import { program } from 'commander'
import { createRequire } from 'module'
import chalk from 'chalk'
import { createCommand } from './commands/create'
import { listCommand } from './commands/list'
import { startCommand } from './commands/start'
import { stopCommand } from './commands/stop'
import { deleteCommand } from './commands/delete'
import { restoreCommand } from './commands/restore'
import { backupCommand } from './commands/backup'
import { backupsCommand } from './commands/backups'
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
import { databasesCommand } from './commands/databases'
import { pullCommand } from './commands/pull'
import { whichCommand } from './commands/which'
import { exportCommand } from './commands/export'
import { queryCommand } from './commands/query'
import { updateManager } from '../core/update-manager'
import { configManager } from '../core/config-manager'
import { setCachedIconMode } from './constants'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

/**
 * Load user preferences from config (icon mode, etc.)
 * This runs before any command to ensure consistent behavior between CLI and TUI.
 */
async function loadUserPreferences(): Promise<void> {
  try {
    const config = await configManager.getConfig()
    if (config.preferences?.iconMode) {
      setCachedIconMode(config.preferences.iconMode)
    }
  } catch {
    // Silently ignore - preferences are not critical for CLI functionality
  }
}

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
    console.log(chalk.cyan('─'.repeat(50)))
    console.log(
      chalk.yellow('  Update available! ') +
        chalk.gray(`${currentVersion} -> `) +
        chalk.green(latestVersion),
    )
    console.log(chalk.gray('  Run: ') + chalk.cyan('spindb self-update'))
    console.log(
      chalk.gray('  To disable: ') +
        chalk.gray('spindb config update-check off'),
    )
    console.log(chalk.cyan('─'.repeat(50)))
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
  // Load user preferences (icon mode, etc.) before any command runs
  await loadUserPreferences()

  // Trigger background update check (non-blocking, updates cache for next run)
  triggerBackgroundUpdateCheck()

  program
    .name('spindb')
    .description('Spin up local database containers without Docker')
    .version(pkg.version, '-v, --version', 'output the version number')
    .enablePositionalOptions()

  program.addCommand(createCommand)
  program.addCommand(listCommand)
  program.addCommand(startCommand)
  program.addCommand(stopCommand)
  program.addCommand(deleteCommand)
  program.addCommand(restoreCommand)
  program.addCommand(backupCommand)
  program.addCommand(backupsCommand)
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
  program.addCommand(databasesCommand)
  program.addCommand(pullCommand)
  program.addCommand(whichCommand)
  program.addCommand(exportCommand)
  program.addCommand(queryCommand)

  if (process.argv.length <= 2) {
    // Only show update notification in interactive menu mode (once at startup)
    await showUpdateNotificationIfAvailable()
    await menuCommand.parseAsync([])
    return
  }

  await program.parseAsync()
}
