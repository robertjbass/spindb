import { Command } from 'commander'
import chalk from 'chalk'
import { existsSync } from 'fs'
import { resolve, basename } from 'path'
import { sqliteRegistry } from '../../engines/sqlite/registry'
import {
  scanForUnregisteredSqliteFiles,
  deriveContainerName,
} from '../../engines/sqlite/scanner'
import { containerManager } from '../../core/container-manager'
import { uiSuccess, uiError, uiInfo } from '../ui/theme'
import { detachCommand } from './detach'

export const sqliteCommand = new Command('sqlite').description(
  'SQLite-specific operations',
)

// sqlite scan
sqliteCommand
  .command('scan')
  .description('Scan folder for unregistered SQLite files')
  .option('-p, --path <dir>', 'Directory to scan (default: current directory)')
  .option('--json', 'Output as JSON')
  .action(async (options: { path?: string; json?: boolean }): Promise<void> => {
    const dir = options.path ? resolve(options.path) : process.cwd()

    if (!existsSync(dir)) {
      if (options.json) {
        console.log(
          JSON.stringify({ error: 'Directory not found', directory: dir }),
        )
      } else {
        console.error(uiError(`Directory not found: ${dir}`))
      }
      process.exit(1)
    }

    const unregistered = await scanForUnregisteredSqliteFiles(dir)

    if (options.json) {
      console.log(JSON.stringify({ directory: dir, files: unregistered }))
      return
    }

    if (unregistered.length === 0) {
      console.log(uiInfo(`No unregistered SQLite files found in ${dir}`))
      return
    }

    console.log(
      chalk.cyan(`Found ${unregistered.length} unregistered SQLite file(s):`),
    )
    for (const file of unregistered) {
      console.log(chalk.gray(`  ${file.fileName}`))
    }
    console.log()
    console.log(chalk.gray('  Register with: spindb attach <path>'))
  })

// sqlite ignore
sqliteCommand
  .command('ignore')
  .description('Add folder to ignore list for CWD scanning')
  .argument('[folder]', 'Folder path to ignore (default: current directory)')
  .option('--json', 'Output as JSON')
  .action(
    async (
      folder: string | undefined,
      options: { json?: boolean },
    ): Promise<void> => {
      const absolutePath = resolve(folder || process.cwd())
      await sqliteRegistry.addIgnoreFolder(absolutePath)

      if (options.json) {
        console.log(JSON.stringify({ success: true, folder: absolutePath }))
      } else {
        console.log(uiSuccess(`Added to ignore list: ${absolutePath}`))
      }
    },
  )

// sqlite unignore
sqliteCommand
  .command('unignore')
  .description('Remove folder from ignore list')
  .argument('[folder]', 'Folder path to unignore (default: current directory)')
  .option('--json', 'Output as JSON')
  .action(
    async (
      folder: string | undefined,
      options: { json?: boolean },
    ): Promise<void> => {
      const absolutePath = resolve(folder || process.cwd())
      const removed = await sqliteRegistry.removeIgnoreFolder(absolutePath)

      if (options.json) {
        console.log(JSON.stringify({ success: removed, folder: absolutePath }))
      } else {
        if (removed) {
          console.log(uiSuccess(`Removed from ignore list: ${absolutePath}`))
        } else {
          console.log(uiInfo(`Folder was not in ignore list: ${absolutePath}`))
        }
      }
    },
  )

// sqlite ignored (list ignored folders)
sqliteCommand
  .command('ignored')
  .description('List ignored folders')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }): Promise<void> => {
    const folders = await sqliteRegistry.listIgnoredFolders()

    if (options.json) {
      console.log(JSON.stringify({ folders }))
      return
    }

    if (folders.length === 0) {
      console.log(uiInfo('No folders are being ignored'))
      return
    }

    console.log(chalk.cyan('Ignored folders:'))
    for (const folder of folders) {
      console.log(chalk.gray(`  ${folder}`))
    }
  })

// sqlite attach (alias to top-level attach)
sqliteCommand
  .command('attach')
  .description(
    'Register an existing SQLite database (alias for "spindb attach")',
  )
  .argument('<path>', 'Path to SQLite database file')
  .option('-n, --name <name>', 'Container name')
  .option('--json', 'Output as JSON')
  .action(
    async (
      path: string,
      options: { name?: string; json?: boolean },
    ): Promise<void> => {
      try {
        const absolutePath = resolve(path)

        if (!existsSync(absolutePath)) {
          if (options.json) {
            console.log(
              JSON.stringify({ success: false, error: 'File not found' }),
            )
          } else {
            console.error(uiError(`File not found: ${absolutePath}`))
          }
          process.exit(1)
        }

        if (await sqliteRegistry.isPathRegistered(absolutePath)) {
          const entry = await sqliteRegistry.getByPath(absolutePath)
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                error: 'Already registered',
                existingName: entry?.name,
              }),
            )
          } else {
            console.error(
              uiError(`File is already registered as "${entry?.name}"`),
            )
          }
          process.exit(1)
        }

        const containerName =
          options.name || deriveContainerName(basename(absolutePath))

        if (await containerManager.exists(containerName)) {
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                error: 'Container name already exists',
              }),
            )
          } else {
            console.error(
              uiError(`Container "${containerName}" already exists`),
            )
          }
          process.exit(1)
        }

        await sqliteRegistry.add({
          name: containerName,
          filePath: absolutePath,
          created: new Date().toISOString(),
        })

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              name: containerName,
              filePath: absolutePath,
            }),
          )
        } else {
          console.log(
            uiSuccess(
              `Registered "${basename(absolutePath)}" as "${containerName}"`,
            ),
          )
          console.log()
          console.log(chalk.gray('  Connect with:'))
          console.log(chalk.cyan(`    spindb connect ${containerName}`))
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )

// sqlite detach (alias to top-level detach)
sqliteCommand
  .command('detach')
  .description('Unregister a SQLite database (alias for "spindb detach")')
  .argument('<name>', 'Container name')
  .option('-f, --force', 'Skip confirmation')
  .option('--json', 'Output as JSON')
  .action(
    async (
      name: string,
      options: { force?: boolean; json?: boolean },
    ): Promise<void> => {
      // Build args array
      const args = ['node', 'detach', name]
      if (options.force) args.push('-f')
      if (options.json) args.push('--json')

      await detachCommand.parseAsync(args, { from: 'node' })
    },
  )
