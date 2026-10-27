import { program, type Command } from 'commander'
import chalk from 'chalk'
import { VERSION } from '../config/version'
import { updateManager } from '../core/update-manager'
import { configManager } from '../core/config-manager'
import { setCachedIconMode } from './constants'

type CommandEntry = {
  // Name plus aliases, exactly as each command module declares them.
  // tests/unit/cli-lazy-commands.test.ts pins these to the real commands.
  names: readonly string[]
  load: () => Promise<Command>
}

/**
 * Every top-level command, in help order, loaded on demand.
 *
 * Command modules are imported only when dispatched, not at startup. Importing
 * all of them (and through them every engine) cost about 300 modules on every
 * invocation, which dominated cheap commands such as `spindb list --json`.
 * Layerbase Cloud runs that command once a minute per container on a 0.5-CPU
 * budget, where the eager load took over a second. When the first argument is
 * a known command name, only that module loads; for anything else (no command,
 * `--help`, `help`, an unknown command or option) every command loads in this
 * order, so help text and error messages are unchanged.
 */
export const COMMAND_ENTRIES: readonly CommandEntry[] = [
  {
    names: ['create'],
    load: async () => (await import('./commands/create')).createCommand,
  },
  {
    names: ['list', 'ls'],
    load: async () => (await import('./commands/list')).listCommand,
  },
  {
    names: ['ports'],
    load: async () => (await import('./commands/ports')).portsCommand,
  },
  {
    names: ['start'],
    load: async () => (await import('./commands/start')).startCommand,
  },
  {
    names: ['stop'],
    load: async () => (await import('./commands/stop')).stopCommand,
  },
  {
    names: ['delete', 'rm'],
    load: async () => (await import('./commands/delete')).deleteCommand,
  },
  {
    names: ['restore'],
    load: async () => (await import('./commands/restore')).restoreCommand,
  },
  {
    names: ['backup'],
    load: async () => (await import('./commands/backup')).backupCommand,
  },
  {
    names: ['backups'],
    load: async () => (await import('./commands/backups')).backupsCommand,
  },
  {
    names: ['connect', 'shell'],
    load: async () => (await import('./commands/connect')).connectCommand,
  },
  {
    names: ['clone'],
    load: async () => (await import('./commands/clone')).cloneCommand,
  },
  {
    names: ['branch'],
    load: async () => (await import('./commands/branch')).branchCommand,
  },
  {
    names: ['menu'],
    load: async () => (await import('./commands/menu')).menuCommand,
  },
  {
    names: ['config', 'configure'],
    load: async () => (await import('./commands/config')).configCommand,
  },
  {
    names: ['deps'],
    load: async () => (await import('./commands/deps')).depsCommand,
  },
  {
    names: ['engines'],
    load: async () => (await import('./commands/engines')).enginesCommand,
  },
  {
    names: ['edit'],
    load: async () => (await import('./commands/edit')).editCommand,
  },
  {
    names: ['url', 'connection-string'],
    load: async () => (await import('./commands/url')).urlCommand,
  },
  {
    names: ['info', 'status'],
    load: async () => (await import('./commands/info')).infoCommand,
  },
  {
    names: ['self-update', 'update'],
    load: async () =>
      (await import('./commands/self-update')).selfUpdateCommand,
  },
  {
    names: ['version'],
    load: async () => (await import('./commands/version')).versionCommand,
  },
  {
    names: ['run'],
    load: async () => (await import('./commands/run')).runCommand,
  },
  {
    names: ['logs'],
    load: async () => (await import('./commands/logs')).logsCommand,
  },
  {
    names: ['doctor'],
    load: async () => (await import('./commands/doctor')).doctorCommand,
  },
  {
    names: ['attach'],
    load: async () => (await import('./commands/attach')).attachCommand,
  },
  {
    names: ['detach'],
    load: async () => (await import('./commands/detach')).detachCommand,
  },
  {
    names: ['sqlite'],
    load: async () => (await import('./commands/sqlite')).sqliteCommand,
  },
  {
    names: ['duckdb'],
    load: async () => (await import('./commands/duckdb')).duckdbCommand,
  },
  {
    names: ['databases'],
    load: async () => (await import('./commands/databases')).databasesCommand,
  },
  {
    names: ['pull'],
    load: async () => (await import('./commands/pull')).pullCommand,
  },
  {
    names: ['which'],
    load: async () => (await import('./commands/which')).whichCommand,
  },
  {
    names: ['export'],
    load: async () => (await import('./commands/export')).exportCommand,
  },
  {
    names: ['query'],
    load: async () => (await import('./commands/query')).queryCommand,
  },
  {
    names: ['users'],
    load: async () => (await import('./commands/users')).usersCommand,
  },
  {
    names: ['link'],
    load: async () => (await import('./commands/link')).linkCommand,
  },
  {
    names: ['bin-path'],
    load: async () => (await import('./commands/bin-path')).binPathCommand,
  },
]

const VERSION_FLAGS = new Set(['-v', '--version'])

/**
 * The commands to register for this invocation. `args` is argv without the
 * node and script entries. Returns:
 * - nothing when the first argument is the root version flag (commander prints
 *   the version and exits before any command is consulted);
 * - only the named command when the first argument is a command name or alias;
 * - every command otherwise, so root help, `help <cmd>`, and unknown-command
 *   suggestions see the full set.
 */
export function selectCommandEntries(
  args: readonly string[],
): readonly CommandEntry[] {
  const first = args[0]
  if (first === undefined) return COMMAND_ENTRIES
  if (VERSION_FLAGS.has(first)) return []
  const match = COMMAND_ENTRIES.find((entry) => entry.names.includes(first))
  return match ? [match] : COMMAND_ENTRIES
}

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
    .version(VERSION, '-v, --version', 'output the version number')
    .enablePositionalOptions()

  if (process.argv.length <= 2) {
    const { menuCommand } = await import('./commands/menu')
    program.addCommand(menuCommand)
    // Only show update notification in interactive menu mode (once at startup)
    await showUpdateNotificationIfAvailable()
    await menuCommand.parseAsync([])
    return
  }

  // Sequential on purpose: modules evaluate in the same order the former
  // static imports did.
  for (const entry of selectCommandEntries(process.argv.slice(2))) {
    program.addCommand(await entry.load())
  }

  await program.parseAsync()
}
