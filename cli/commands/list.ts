import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { dirname, basename } from 'path'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { uiInfo, uiError, formatBytes } from '../ui/theme'
import { getEngineIcon } from '../constants'
import { Engine } from '../../types'
import type { ContainerConfig } from '../../types'
import { sqliteRegistry } from '../../engines/sqlite/registry'
import {
  scanForUnregisteredSqliteFiles,
  deriveContainerName,
} from '../../engines/sqlite/scanner'

// Pad string to width, accounting for emoji taking 2 display columns
function padWithEmoji(str: string, width: number): string {
  // Count emojis using Extended_Pictographic (excludes digits/symbols that \p{Emoji} matches)
  const emojiCount = (str.match(/\p{Extended_Pictographic}/gu) || []).length
  return str.padEnd(width + emojiCount)
}

/**
 * Prompt user about unregistered SQLite files in CWD
 * Returns true if user registered any files (refresh needed)
 */
async function promptUnregisteredFiles(): Promise<boolean> {
  const unregistered = await scanForUnregisteredSqliteFiles()

  if (unregistered.length === 0) {
    return false
  }

  let anyRegistered = false

  for (let i = 0; i < unregistered.length; i++) {
    const file = unregistered[i]
    const prompt =
      unregistered.length > 1 ? `[${i + 1} of ${unregistered.length}] ` : ''

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: `${prompt}Unregistered SQLite database "${file.fileName}" found in current directory. Register with SpinDB?`,
        choices: [
          { name: 'Yes', value: 'yes' },
          { name: 'No', value: 'no' },
          { name: "No - don't ask again for this folder", value: 'ignore' },
        ],
      },
    ])

    if (action === 'yes') {
      const suggestedName = deriveContainerName(file.fileName)
      const { containerName } = await inquirer.prompt<{
        containerName: string
      }>([
        {
          type: 'input',
          name: 'containerName',
          message: 'Container name:',
          default: suggestedName,
          validate: (input: string) => {
            if (!input) return 'Name is required'
            if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
              return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores'
            }
            return true
          },
        },
      ])

      // Check if name already exists
      if (await sqliteRegistry.exists(containerName)) {
        console.log(
          chalk.yellow(
            `  Container "${containerName}" already exists. Skipping.`,
          ),
        )
        continue
      }

      await sqliteRegistry.add({
        name: containerName,
        filePath: file.absolutePath,
        created: new Date().toISOString(),
      })
      console.log(
        chalk.green(`  Registered "${file.fileName}" as "${containerName}"`),
      )
      anyRegistered = true
    } else if (action === 'ignore') {
      await sqliteRegistry.addIgnoreFolder(dirname(file.absolutePath))
      console.log(chalk.gray('  Folder will be ignored in future scans.'))
      break // Exit early
    }
  }

  if (anyRegistered) {
    console.log() // Add spacing before list
  }

  return anyRegistered
}

async function getContainerSize(
  container: ContainerConfig,
): Promise<number | null> {
  // SQLite can always get size (it's just file size)
  if (container.engine === Engine.SQLite) {
    try {
      const engine = getEngine(container.engine)
      return await engine.getDatabaseSize(container)
    } catch {
      return null
    }
  }

  // Server databases need to be running
  if (container.status !== 'running') {
    return null
  }
  try {
    const engine = getEngine(container.engine)
    return await engine.getDatabaseSize(container)
  } catch {
    return null
  }
}

export const listCommand = new Command('list')
  .alias('ls')
  .description('List all containers')
  .option('--json', 'Output as JSON')
  .option('--no-scan', 'Skip scanning for unregistered SQLite files in CWD')
  .action(async (options: { json?: boolean; scan?: boolean }) => {
    try {
      // Scan for unregistered SQLite files in CWD (unless JSON mode or --no-scan)
      if (!options.json && options.scan !== false) {
        await promptUnregisteredFiles()
      }

      const containers = await containerManager.list()

      if (options.json) {
        const containersWithSize = await Promise.all(
          containers.map(async (container) => ({
            ...container,
            sizeBytes: await getContainerSize(container),
          })),
        )
        console.log(JSON.stringify(containersWithSize, null, 2))
        return
      }

      if (containers.length === 0) {
        console.log(
          uiInfo('No containers found. Create one with: spindb create'),
        )
        return
      }

      const sizes = await Promise.all(containers.map(getContainerSize))

      console.log()
      console.log(
        chalk.gray('  ') +
          chalk.bold.white('NAME'.padEnd(20)) +
          chalk.bold.white('ENGINE'.padEnd(15)) +
          chalk.bold.white('VERSION'.padEnd(10)) +
          chalk.bold.white('PORT'.padEnd(8)) +
          chalk.bold.white('SIZE'.padEnd(10)) +
          chalk.bold.white('STATUS'),
      )
      console.log(chalk.gray('  ' + '─'.repeat(73)))

      for (let i = 0; i < containers.length; i++) {
        const container = containers[i]
        const size = sizes[i]

        // SQLite uses different status labels (blue/white icons)
        let statusDisplay: string
        if (container.engine === Engine.SQLite) {
          statusDisplay =
            container.status === 'running'
              ? chalk.blue('🔵 available')
              : chalk.gray('⚪ missing')
        } else {
          statusDisplay =
            container.status === 'running'
              ? chalk.green('● running')
              : chalk.gray('○ stopped')
        }

        const engineIcon = getEngineIcon(container.engine)
        const engineDisplay = `${engineIcon} ${container.engine}`

        const sizeDisplay = size !== null ? formatBytes(size) : chalk.gray('—')

        // SQLite shows truncated file name instead of port
        let portOrPath: string
        if (container.engine === Engine.SQLite) {
          const fileName = basename(container.database)
          // Truncate if longer than 8 chars to fit in 8-char column
          portOrPath =
            fileName.length > 8 ? fileName.slice(0, 7) + '…' : fileName
        } else {
          portOrPath = String(container.port)
        }

        console.log(
          chalk.gray('  ') +
            chalk.cyan(container.name.padEnd(20)) +
            chalk.white(padWithEmoji(engineDisplay, 14)) +
            chalk.yellow(container.version.padEnd(10)) +
            chalk.green(portOrPath.padEnd(8)) +
            chalk.magenta(sizeDisplay.padEnd(10)) +
            statusDisplay,
        )
      }

      console.log()

      const serverContainers = containers.filter(
        (c) => c.engine !== Engine.SQLite,
      )
      const sqliteContainers = containers.filter(
        (c) => c.engine === Engine.SQLite,
      )

      const running = serverContainers.filter(
        (c) => c.status === 'running',
      ).length
      const stopped = serverContainers.filter(
        (c) => c.status !== 'running',
      ).length
      const available = sqliteContainers.filter(
        (c) => c.status === 'running',
      ).length
      const missing = sqliteContainers.filter(
        (c) => c.status !== 'running',
      ).length

      const parts: string[] = []
      if (serverContainers.length > 0) {
        parts.push(`${running} running, ${stopped} stopped`)
      }
      if (sqliteContainers.length > 0) {
        parts.push(
          `${available} SQLite available${missing > 0 ? `, ${missing} missing` : ''}`,
        )
      }

      console.log(
        chalk.gray(`  ${containers.length} container(s): ${parts.join('; ')}`),
      )
      console.log()
    } catch (error) {
      const e = error as Error
      console.error(uiError(e.message))
      process.exit(1)
    }
  })
