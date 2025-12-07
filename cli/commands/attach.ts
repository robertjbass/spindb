import { Command } from 'commander'
import { existsSync } from 'fs'
import { resolve, basename } from 'path'
import chalk from 'chalk'
import { sqliteRegistry } from '../../engines/sqlite/registry'
import { containerManager } from '../../core/container-manager'
import { deriveContainerName } from '../../engines/sqlite/scanner'
import { uiSuccess, uiError } from '../ui/theme'

export const attachCommand = new Command('attach')
  .description('Register an existing SQLite database with SpinDB')
  .argument('<path>', 'Path to SQLite database file')
  .option('-n, --name <name>', 'Container name (defaults to filename)')
  .option('--json', 'Output as JSON')
  .action(
    async (
      path: string,
      options: { name?: string; json?: boolean },
    ): Promise<void> => {
      try {
        const absolutePath = resolve(path)

        // Verify file exists
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

        // Check if already registered
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

        // Determine container name
        const containerName =
          options.name || deriveContainerName(basename(absolutePath))

        // Check if container name exists
        if (await containerManager.exists(containerName)) {
          if (options.json) {
            console.log(
              JSON.stringify({
                success: false,
                error: 'Container name already exists',
              }),
            )
          } else {
            console.error(uiError(`Container "${containerName}" already exists`))
          }
          process.exit(1)
        }

        // Register the file
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
