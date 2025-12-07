import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { info, error, formatBytes } from '../ui/theme'
import { getEngineIcon } from '../constants'
import { Engine } from '../../types'
import { basename } from 'path'
import type { ContainerConfig } from '../../types'

/**
 * Pad string to width, accounting for emoji taking 2 display columns
 */
function padWithEmoji(str: string, width: number): string {
  // Count emojis using Extended_Pictographic (excludes digits/symbols that \p{Emoji} matches)
  const emojiCount = (str.match(/\p{Extended_Pictographic}/gu) || []).length
  return str.padEnd(width + emojiCount)
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
  .action(async (options: { json?: boolean }) => {
    try {
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
        console.log(info('No containers found. Create one with: spindb create'))
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
          portOrPath = fileName.length > 8 ? fileName.slice(0, 7) + '…' : fileName
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

      const serverContainers = containers.filter((c) => c.engine !== Engine.SQLite)
      const sqliteContainers = containers.filter((c) => c.engine === Engine.SQLite)

      const running = serverContainers.filter((c) => c.status === 'running').length
      const stopped = serverContainers.filter((c) => c.status !== 'running').length
      const available = sqliteContainers.filter((c) => c.status === 'running').length
      const missing = sqliteContainers.filter((c) => c.status !== 'running').length

      const parts: string[] = []
      if (serverContainers.length > 0) {
        parts.push(`${running} running, ${stopped} stopped`)
      }
      if (sqliteContainers.length > 0) {
        parts.push(`${available} SQLite available${missing > 0 ? `, ${missing} missing` : ''}`)
      }

      console.log(
        chalk.gray(
          `  ${containers.length} container(s): ${parts.join('; ')}`,
        ),
      )
      console.log()
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })
