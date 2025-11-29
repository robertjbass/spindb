import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { info, error } from '../ui/theme'

/**
 * Engine icons for display
 */
const engineIcons: Record<string, string> = {
  postgresql: '🐘',
  mysql: '🐬',
}

export const listCommand = new Command('list')
  .alias('ls')
  .description('List all containers')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const containers = await containerManager.list()

      if (options.json) {
        console.log(JSON.stringify(containers, null, 2))
        return
      }

      if (containers.length === 0) {
        console.log(info('No containers found. Create one with: spindb create'))
        return
      }

      // Table header
      console.log()
      console.log(
        chalk.gray('  ') +
          chalk.bold.white('NAME'.padEnd(20)) +
          chalk.bold.white('ENGINE'.padEnd(15)) +
          chalk.bold.white('VERSION'.padEnd(10)) +
          chalk.bold.white('PORT'.padEnd(8)) +
          chalk.bold.white('STATUS'),
      )
      console.log(chalk.gray('  ' + '─'.repeat(63)))

      // Table rows
      for (const container of containers) {
        const statusDisplay =
          container.status === 'running'
            ? chalk.green('● running')
            : chalk.gray('○ stopped')

        const engineIcon = engineIcons[container.engine] || '▣'
        const engineDisplay = `${engineIcon} ${container.engine}`

        console.log(
          chalk.gray('  ') +
            chalk.cyan(container.name.padEnd(20)) +
            chalk.white(engineDisplay.padEnd(14)) +
            chalk.yellow(container.version.padEnd(10)) +
            chalk.green(String(container.port).padEnd(8)) +
            statusDisplay,
        )
      }

      console.log()

      // Summary
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
