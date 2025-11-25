import { Command } from 'commander'
import { existsSync } from 'fs'
import chalk from 'chalk'
import { containerManager } from '@/core/container-manager'
import { processManager } from '@/core/process-manager'
import { getEngine } from '@/engines'
import { promptContainerSelect, promptDatabaseName } from '@/cli/ui/prompts'
import { createSpinner } from '@/cli/ui/spinner'
import { success, error, warning } from '@/cli/ui/theme'

export const restoreCommand = new Command('restore')
  .description('Restore a backup to a container')
  .argument('[name]', 'Container name')
  .argument('[backup]', 'Path to backup file')
  .option('-d, --database <name>', 'Target database name')
  .action(
    async (
      name: string | undefined,
      backup: string | undefined,
      options: { database?: string },
    ) => {
      try {
        let containerName = name
        const backupPath = backup

        // Interactive selection if no name provided
        if (!containerName) {
          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            if (containers.length === 0) {
              console.log(
                warning('No containers found. Create one with: spindb create'),
              )
            } else {
              console.log(
                warning(
                  'No running containers. Start one first with: spindb start',
                ),
              )
            }
            return
          }

          const selected = await promptContainerSelect(
            running,
            'Select container to restore to:',
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

        // Check if running
        const running = await processManager.isRunning(containerName)
        if (!running) {
          console.error(
            error(
              `Container "${containerName}" is not running. Start it first.`,
            ),
          )
          process.exit(1)
        }

        // Check backup file
        if (!backupPath) {
          console.error(error('Backup file path is required'))
          console.log(
            chalk.gray('  Usage: spindb restore <container> <backup-file>'),
          )
          process.exit(1)
        }

        if (!existsSync(backupPath)) {
          console.error(error(`Backup file not found: ${backupPath}`))
          process.exit(1)
        }

        // Get database name
        let databaseName = options.database
        if (!databaseName) {
          databaseName = await promptDatabaseName(containerName)
        }

        // Get engine
        const engine = getEngine(config.engine)

        // Detect backup format
        const detectSpinner = createSpinner('Detecting backup format...')
        detectSpinner.start()

        const format = await engine.detectBackupFormat(backupPath)
        detectSpinner.succeed(`Detected: ${format.description}`)

        // Create database
        const dbSpinner = createSpinner(
          `Creating database "${databaseName}"...`,
        )
        dbSpinner.start()

        await engine.createDatabase(config, databaseName)
        dbSpinner.succeed(`Database "${databaseName}" ready`)

        // Restore backup
        const restoreSpinner = createSpinner('Restoring backup...')
        restoreSpinner.start()

        const result = await engine.restore(config, backupPath, {
          database: databaseName,
          createDatabase: false, // Already created
        })

        if (result.code === 0 || !result.stderr) {
          restoreSpinner.succeed('Backup restored successfully')
        } else {
          // pg_restore often returns warnings even on success
          restoreSpinner.warn('Restore completed with warnings')
          if (result.stderr) {
            console.log(chalk.yellow('\n  Warnings:'))
            const lines = result.stderr.split('\n').slice(0, 5)
            lines.forEach((line) => {
              if (line.trim()) {
                console.log(chalk.gray(`    ${line}`))
              }
            })
            if (result.stderr.split('\n').length > 5) {
              console.log(chalk.gray('    ...'))
            }
          }
        }

        // Show connection info
        const connectionString = engine.getConnectionString(
          config,
          databaseName,
        )
        console.log()
        console.log(success(`Database "${databaseName}" restored`))
        console.log()
        console.log(chalk.gray('  Connection string:'))
        console.log(chalk.cyan(`  ${connectionString}`))
        console.log()
        console.log(chalk.gray('  Connect with:'))
        console.log(
          chalk.cyan(`  spindb connect ${containerName} -d ${databaseName}`),
        )
        console.log()
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
