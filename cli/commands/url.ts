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
  .option('--json', 'Output as JSON with additional connection info')
  .action(
    async (
      name: string | undefined,
      options: { copy?: boolean; database?: string; json?: boolean },
    ) => {
      try {
        let containerName = name

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

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(error(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const engine = getEngine(config.engine)
        const databaseName = options.database || config.database
        const connectionString = engine.getConnectionString(config, databaseName)

        if (options.json) {
          const jsonOutput =
            config.engine === 'sqlite'
              ? {
                  connectionString,
                  path: databaseName,
                  engine: config.engine,
                  container: config.name,
                }
              : {
                  connectionString,
                  host: '127.0.0.1',
                  port: config.port,
                  database: databaseName,
                  user: config.engine === 'postgresql' ? 'postgres' : 'root',
                  engine: config.engine,
                  container: config.name,
                }
          console.log(JSON.stringify(jsonOutput, null, 2))
          return
        }

        if (options.copy) {
          const copied = await platformService.copyToClipboard(connectionString)
          if (copied) {
            console.log(connectionString)
            console.error(success('Copied to clipboard'))
          } else {
            console.log(connectionString)
            console.error(warning('Could not copy to clipboard'))
          }
        } else {
          process.stdout.write(connectionString)
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
