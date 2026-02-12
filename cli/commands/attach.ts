import { Command } from 'commander'
import { existsSync } from 'fs'
import { resolve, basename } from 'path'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import {
  detectEngineFromPath,
  getRegistryForEngine,
  deriveContainerName,
  formatAllExtensions,
} from '../../engines/file-based-utils'
import { uiSuccess, uiError } from '../ui/theme'
import type { Engine } from '../../types'

export const attachCommand = new Command('attach')
  .description(
    'Register an existing file-based database with SpinDB (SQLite or DuckDB)',
  )
  .argument(
    '<path>',
    'Path to database file (.sqlite, .db, .sqlite3, .duckdb, .ddb)',
  )
  .option('-n, --name <name>', 'Container name (defaults to filename)')
  .option('--json', 'Output as JSON')
  .action(
    async (
      path: string,
      options: { name?: string; json?: boolean },
    ): Promise<void> => {
      try {
        const absolutePath = resolve(path)

        // Detect engine from file extension
        const engine = detectEngineFromPath(absolutePath)
        if (!engine) {
          const msg = `Unrecognized file extension. Expected one of: ${formatAllExtensions()}`
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: msg }))
          } else {
            console.error(uiError(msg))
          }
          process.exit(1)
        }

        const registry = getRegistryForEngine(engine)

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
        if (await registry.isPathRegistered(absolutePath)) {
          const entry = await registry.getByPath(absolutePath)
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
          options.name ||
          deriveContainerName(
            basename(absolutePath),
            engine as Engine.SQLite | Engine.DuckDB,
          )

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
            console.error(
              uiError(`Container "${containerName}" already exists`),
            )
          }
          process.exit(1)
        }

        // Register the file
        await registry.add({
          name: containerName,
          filePath: absolutePath,
          created: new Date().toISOString(),
        })

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              engine,
              name: containerName,
              filePath: absolutePath,
            }),
          )
        } else {
          console.log(
            uiSuccess(
              `Registered "${basename(absolutePath)}" as "${containerName}" (${engine})`,
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
