/**
 * Pull Command
 *
 * Pulls remote database data into a local container, with optional backup
 * of the original local data.
 *
 * Usage:
 *   spindb pull <container> --from <url>                    # Replace mode
 *   spindb pull <container> --from <url> --as <name>        # Clone mode
 *   spindb pull <container> --from <url> --no-backup -f     # Replace without backup
 *   spindb pull <container> --from <url> --dry-run          # Preview changes
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { pullManager } from '../../core/pull-manager'
import { containerManager } from '../../core/container-manager'
import { createSpinner } from '../ui/spinner'
import { promptConfirm } from '../ui/prompts'
import { uiError } from '../ui/theme'

export const pullCommand = new Command('pull')
  .description('Pull remote database data into local container')
  .argument('<container>', 'Container name')
  .option('--from <url>', 'Remote database connection string')
  .option('--from-env <name>', 'Read remote URL from environment variable')
  .option('-d, --database <name>', 'Target database (default: primary)')
  .option('--as <name>', 'Clone to new database instead of replacing')
  .option('--no-backup', 'Skip backup when replacing (dangerous)')
  .option('--post-script <path>', 'Run script after pull completes')
  .option('--dry-run', 'Preview changes without executing')
  .option('-f, --force', 'Skip confirmation prompts')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      container: string,
      options: {
        from?: string
        fromEnv?: string
        database?: string
        as?: string
        backup: boolean // Commander inverts --no-backup to backup: false
        postScript?: string
        dryRun?: boolean
        force?: boolean
        json?: boolean
      },
    ) => {
      try {
        // Resolve remote URL from --from or --from-env
        let fromUrl = options.from
        if (options.fromEnv) {
          fromUrl = process.env[options.fromEnv]
          if (!fromUrl) {
            const errorMsg = `Environment variable "${options.fromEnv}" is not set or empty`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        // Must specify either --from or --from-env
        if (!fromUrl) {
          const errorMsg =
            'Must specify either --from <url> or --from-env <name>'
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
            console.log(
              chalk.dim('  Usage: spindb pull <container> --from <url>'),
            )
            console.log(
              chalk.dim(
                '         spindb pull <container> --from-env CLONE_FROM_DATABASE_URL',
              ),
            )
          }
          process.exit(1)
        }

        // Validate container exists
        const config = await containerManager.getConfig(container)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({ error: `Container "${container}" not found` }),
            )
          } else {
            console.error(uiError(`Container "${container}" not found`))
          }
          process.exit(1)
        }

        // Validate dangerous combinations
        if (
          !options.backup &&
          !options.force &&
          !options.dryRun &&
          !options.as
        ) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error:
                  'Cannot use --no-backup without --force. Use --force to confirm.',
              }),
            )
            process.exit(1)
          }

          const confirmed = await promptConfirm(
            'This will overwrite your database WITHOUT creating a backup. Continue?',
            false,
          )
          if (!confirmed) {
            console.log(chalk.gray('Aborted.'))
            process.exit(0)
          }
        }

        const spinner =
          options.json || options.dryRun
            ? null
            : createSpinner('Pulling remote data...')

        spinner?.start()

        // Show progress updates
        const updateSpinner = (message: string) => {
          if (spinner) {
            spinner.text = message
          }
        }

        if (!options.json && !options.dryRun) {
          updateSpinner('Validating container...')
        }

        const result = await pullManager.pull(container, {
          database: options.database,
          fromUrl: fromUrl,
          asDatabase: options.as,
          noBackup: !options.backup,
          postScript: options.postScript,
          dryRun: options.dryRun,
          force: options.force,
          json: options.json,
        })

        spinner?.succeed(result.message)

        if (options.json) {
          console.log(JSON.stringify(result))
        } else if (!options.dryRun) {
          console.log('')
          console.log(chalk.green('Pull complete!'))
          console.log('')
          console.log(`  ${chalk.dim('Mode:')}      ${result.mode}`)
          console.log(
            `  ${chalk.dim('Database:')}  ${chalk.cyan(result.database)}`,
          )
          if (result.backupDatabase) {
            console.log(
              `  ${chalk.dim('Backup:')}    ${chalk.cyan(result.backupDatabase)}`,
            )
          }
          console.log(
            `  ${chalk.dim('Source:')}    ${chalk.gray(result.source)}`,
          )
          console.log('')

          if (result.mode === 'replace') {
            console.log(chalk.dim('Your connection string is unchanged:'))
            console.log(chalk.white(`  ${result.databaseUrl}`))
          } else {
            console.log(
              chalk.yellow('Update your .env to use the new database:'),
            )
            console.log(chalk.white(`  DATABASE_URL=${result.databaseUrl}`))
          }
          console.log('')
          console.log(
            chalk.bgYellow.black(
              ' Restart your dev server to use the new data. ',
            ),
          )
          console.log('')
        } else {
          // Dry run output
          console.log('')
          console.log(chalk.yellow('DRY RUN - No changes made'))
          console.log('')
          console.log('Would perform:')
          console.log(`  ${chalk.dim('Mode:')}      ${result.mode}`)
          console.log(
            `  ${chalk.dim('Database:')}  ${chalk.cyan(result.database)}`,
          )
          if (result.backupDatabase) {
            console.log(
              `  ${chalk.dim('Backup:')}    ${chalk.cyan(result.backupDatabase)}`,
            )
          }
          console.log(
            `  ${chalk.dim('Source:')}    ${chalk.gray(result.source)}`,
          )
          console.log('')
        }
      } catch (error) {
        const e = error as Error

        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
