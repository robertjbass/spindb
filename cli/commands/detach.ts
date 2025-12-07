import { Command } from 'commander'
import chalk from 'chalk'
import { sqliteRegistry } from '../../engines/sqlite/registry'
import { containerManager } from '../../core/container-manager'
import { promptConfirm } from '../ui/prompts'
import { uiSuccess, uiError, uiWarning } from '../ui/theme'
import { Engine } from '../../types'

export const detachCommand = new Command('detach')
  .description('Unregister a SQLite database from SpinDB (keeps file on disk)')
  .argument('<name>', 'Container name')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--json', 'Output as JSON')
  .action(
    async (
      name: string,
      options: { force?: boolean; json?: boolean },
    ): Promise<void> => {
      try {
        // Get container config
        const config = await containerManager.getConfig(name)

        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({ success: false, error: 'Container not found' }),
            )
          } else {
            console.error(uiError(`Container "${name}" not found`))
          }
          process.exit(1)
        }

        // Verify it's a SQLite container
        if (config.engine !== Engine.SQLite) {
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                error:
                  'Not a SQLite container. Use "spindb delete" for server databases.',
              }),
            )
          } else {
            console.error(uiError(`"${name}" is not a SQLite container`))
            console.log(
              chalk.gray(
                '  Use "spindb delete" for server databases (PostgreSQL, MySQL)',
              ),
            )
          }
          process.exit(1)
        }

        // Confirm unless --force
        if (!options.force && !options.json) {
          const confirmed = await promptConfirm(
            `Detach "${name}" from SpinDB? (file will be kept on disk)`,
            true,
          )
          if (!confirmed) {
            console.log(uiWarning('Cancelled'))
            return
          }
        }

        const entry = await sqliteRegistry.get(name)
        const filePath = entry?.filePath

        // Remove from registry only (not the file)
        await sqliteRegistry.remove(name)

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              name,
              filePath,
            }),
          )
        } else {
          console.log(uiSuccess(`Detached "${name}" from SpinDB`))
          if (filePath) {
            console.log(chalk.gray(`  File remains at: ${filePath}`))
          }
          console.log()
          console.log(chalk.gray('  Re-attach with:'))
          console.log(chalk.cyan(`    spindb attach ${filePath || '<path>'}`))
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
