import { Command } from 'commander'
import { existsSync } from 'fs'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptInstallDependencies } from '../ui/prompts'
import { error, warning } from '../ui/theme'
import { getMissingDependencies } from '../../core/dependency-manager'

export const runCommand = new Command('run')
  .description('Run SQL file or statement against a container')
  .argument('<name>', 'Container name')
  .argument('[file]', 'Path to SQL file')
  .option('-d, --database <name>', 'Target database (defaults to primary)')
  .option('--sql <statement>', 'SQL statement to execute (alternative to file)')
  .action(
    async (
      name: string,
      file: string | undefined,
      options: { database?: string; sql?: string },
    ) => {
      try {
        const containerName = name

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(error(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const { engine: engineName } = config

        const running = await processManager.isRunning(containerName, {
          engine: engineName,
        })
        if (!running) {
          console.error(
            error(
              `Container "${containerName}" is not running. Start it first with: spindb start ${containerName}`,
            ),
          )
          process.exit(1)
        }

        if (file && options.sql) {
          console.error(
            error('Cannot specify both a file and --sql option. Choose one.'),
          )
          process.exit(1)
        }

        if (!file && !options.sql) {
          console.error(error('Must provide either a SQL file or --sql option'))
          console.log(
            chalk.gray('  Usage: spindb run <container> <file.sql>'),
          )
          console.log(
            chalk.gray('     or: spindb run <container> --sql "SELECT ..."'),
          )
          process.exit(1)
        }

        if (file && !existsSync(file)) {
          console.error(error(`SQL file not found: ${file}`))
          process.exit(1)
        }

        const engine = getEngine(engineName)

        let missingDeps = await getMissingDependencies(engineName)
        if (missingDeps.length > 0) {
          console.log(
            warning(
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
              error(
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
          sql: options.sql,
          database,
        })
      } catch (err) {
        const e = err as Error

        const missingToolPatterns = [
          'psql not found',
          'mysql not found',
          'mysql client not found',
        ]

        const matchingPattern = missingToolPatterns.find((p) =>
          e.message.toLowerCase().includes(p.toLowerCase()),
        )

        if (matchingPattern) {
          const missingTool = matchingPattern
            .replace(' not found', '')
            .replace(' client', '')
          const installed = await promptInstallDependencies(missingTool)
          if (installed) {
            console.log(
              chalk.yellow('  Please re-run your command to continue.'),
            )
          }
          process.exit(1)
        }

        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
