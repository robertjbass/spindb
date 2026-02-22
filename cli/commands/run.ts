import { Command } from 'commander'
import { existsSync } from 'fs'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptInstallDependencies } from '../ui/prompts'
import { uiError, uiWarning } from '../ui/theme'
import { getMissingDependencies } from '../../core/dependency-manager'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../../types'

export const runCommand = new Command('run')
  .description('Run script file or command against a container')
  .argument('<name>', 'Container name')
  .argument(
    '[file]',
    'Path to script file (SQL for relational DBs, Redis commands, etc.)',
  )
  .option('-d, --database <name>', 'Target database (defaults to primary)')
  .option('-c, --command <cmd>', 'Command to execute (alternative to file)')
  .option('--sql <statement>', 'Alias for --command (deprecated)')
  .action(
    async (
      name: string,
      file: string | undefined,
      options: { database?: string; command?: string; sql?: string },
    ) => {
      // Deprecation warning for --sql option
      if (options.sql) {
        console.warn(
          uiWarning(
            'The --sql option is deprecated. Use -c/--command instead.',
          ),
        )
      }

      // Support both --command and --sql (deprecated alias)
      // Prefer explicit --command over deprecated --sql
      const command = options.command || options.sql

      try {
        const containerName = name

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(uiError(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const { engine: engineName } = config

        // Remote containers: run not yet supported (engine methods connect to 127.0.0.1)
        if (isRemoteContainer(config)) {
          console.error(
            uiError(
              'Run is not yet supported for linked remote containers. Use "spindb connect" to open a client shell instead.',
            ),
          )
          process.exit(1)
        }

        // File-based databases: check file exists instead of running status
        if (isFileBasedEngine(engineName)) {
          if (!existsSync(config.database)) {
            console.error(
              uiError(`Database file not found: ${config.database}`),
            )
            process.exit(1)
          }
        } else {
          // Server databases need to be running
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            console.error(
              uiError(
                `Container "${containerName}" is not running. Start it first with: spindb start ${containerName}`,
              ),
            )
            process.exit(1)
          }
        }

        if (file && command) {
          console.error(
            uiError(
              'Cannot specify both a file and --command option. Choose one.',
            ),
          )
          process.exit(1)
        }

        if (!file && !command) {
          console.error(
            uiError('Must provide either a script file or --command option'),
          )
          console.log(chalk.gray('  Usage: spindb run <container> <file>'))
          console.log(
            chalk.gray('     or: spindb run <container> -c "command"'),
          )
          process.exit(1)
        }

        if (file && !existsSync(file)) {
          console.error(uiError(`Script file not found: ${file}`))
          process.exit(1)
        }

        const engine = getEngine(engineName)

        let missingDeps = await getMissingDependencies(engineName)
        if (missingDeps.length > 0) {
          console.log(
            uiWarning(
              `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
            ),
          )

          const installed = await promptInstallDependencies(
            missingDeps[0].binary,
            engineName,
          )

          if (!installed) {
            process.exit(1)
          }

          missingDeps = await getMissingDependencies(engineName)
          if (missingDeps.length > 0) {
            console.error(
              uiError(
                `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
              ),
            )
            process.exit(1)
          }

          console.log(chalk.green('  ✓ All required tools are now available'))
          console.log()
        }

        const database = options.database || config.database

        await engine.runScript(config, {
          file,
          sql: command,
          database,
        })
      } catch (error) {
        const e = error as Error

        // Map of tool patterns to their engines
        const toolPatternToEngine: Record<string, Engine> = {
          'psql not found': Engine.PostgreSQL,
          'mysql not found': Engine.MySQL,
          'mysql client not found': Engine.MySQL,
          'redis-cli not found': Engine.Redis,
          'mongosh not found': Engine.MongoDB,
          'sqlite3 not found': Engine.SQLite,
        }

        const matchingPattern = Object.keys(toolPatternToEngine).find((p) =>
          e.message.toLowerCase().includes(p.toLowerCase()),
        )

        if (matchingPattern) {
          const missingTool = matchingPattern
            .replace(' not found', '')
            .replace(' client', '')
          const toolEngine = toolPatternToEngine[matchingPattern]
          const installed = await promptInstallDependencies(
            missingTool,
            toolEngine,
          )
          if (installed) {
            console.log(
              chalk.yellow('  Please re-run your command to continue.'),
            )
          }
          process.exit(1)
        }

        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
