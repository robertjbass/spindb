import { Command } from 'commander'
import { containerManager } from '../../core/container-manager'
import { platformService } from '../../core/platform-service'
import { getEngine } from '../../engines'
import { promptContainerSelect } from '../ui/prompts'
import { error, warning, success } from '../ui/theme'

export const urlCommand = new Command('url')
  .alias('connection-string')
  .description('Output connection string for a container')
  .argument('[name]', 'Container name')
  .option('-c, --copy', 'Copy to clipboard')
  .option('-d, --database <database>', 'Use different database name')
  .action(
    async (
      name: string | undefined,
      options: { copy?: boolean; database?: string },
    ) => {
      try {
        let containerName = name

        // Interactive selection if no name provided
        if (!containerName) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(warning('No containers found'))
            return
          }

          const selected = await promptContainerSelect(
            containers,
            'Select container:',
          )
          if (!selected) return
          containerName = selected
        }

        // Get container config
        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(error(`Container "${containerName}" not found`))
          process.exit(1)
        }

        // Get connection string
        const engine = getEngine(config.engine)
        const connectionString = engine.getConnectionString(
          config,
          options.database,
        )

        // Copy to clipboard if requested
        if (options.copy) {
          const copied = await platformService.copyToClipboard(connectionString)
          if (copied) {
            // Output the string AND confirmation
            console.log(connectionString)
            console.error(success('Copied to clipboard'))
          } else {
            // Output the string but warn about clipboard
            console.log(connectionString)
            console.error(warning('Could not copy to clipboard'))
          }
        } else {
          // Just output the connection string (no newline formatting for easy piping)
          process.stdout.write(connectionString)
          // Add newline if stdout is a TTY (interactive terminal)
          if (process.stdout.isTTY) {
            console.log()
          }
        }
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
