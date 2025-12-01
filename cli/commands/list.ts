import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { info, error, formatBytes } from '../ui/theme'
import { getEngineIcon } from '../constants'
import type { ContainerConfig } from '../../types'

async function getContainerSize(
  container: ContainerConfig,
): Promise<number | null> {
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

        const statusDisplay =
          container.status === 'running'
            ? chalk.green('● running')
            : chalk.gray('○ stopped')

        const engineIcon = getEngineIcon(container.engine)
        const engineDisplay = `${engineIcon} ${container.engine}`

        const sizeDisplay = size !== null ? formatBytes(size) : chalk.gray('—')

        console.log(
          chalk.gray('  ') +
            chalk.cyan(container.name.padEnd(20)) +
            chalk.white(engineDisplay.padEnd(14)) +
            chalk.yellow(container.version.padEnd(10)) +
            chalk.green(String(container.port).padEnd(8)) +
            chalk.magenta(sizeDisplay.padEnd(10)) +
            statusDisplay,
        )
      }

      console.log()

      const running = containers.filter((c) => c.status === 'running').length
      const stopped = containers.filter((c) => c.status !== 'running').length
      console.log(
        chalk.gray(
          `  ${containers.length} container(s): ${running} running, ${stopped} stopped`,
        ),
      )
      console.log()
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })
