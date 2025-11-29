import { Command } from 'commander'
import chalk from 'chalk'
import { updateManager } from '../../core/update-manager'
import { createSpinner } from '../ui/spinner'

export const versionCommand = new Command('version')
  .description('Show version information and check for updates')
  .option('-c, --check', 'Check for available updates')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (options: { check?: boolean; json?: boolean }): Promise<void> => {
      const currentVersion = updateManager.getCurrentVersion()

      if (options.check) {
        const spinner = createSpinner('Checking for updates...')
        if (!options.json) spinner.start()

        const result = await updateManager.checkForUpdate(true)

        if (!options.json) spinner.stop()

        if (options.json) {
          console.log(
            JSON.stringify({
              current: currentVersion,
              latest: result?.latestVersion || null,
              updateAvailable: result?.updateAvailable || false,
            }),
          )
        } else {
          console.log()
          console.log(`SpinDB v${currentVersion}`)
          if (result) {
            if (result.updateAvailable) {
              console.log(
                chalk.yellow(`Update available: v${result.latestVersion}`),
              )
              console.log(chalk.gray("Run 'spindb self-update' to update."))
            } else {
              console.log(chalk.green('You are on the latest version.'))
            }
          } else {
            console.log(chalk.gray('Could not check for updates (offline?)'))
          }
          console.log()
        }
      } else {
        if (options.json) {
          console.log(JSON.stringify({ current: currentVersion }))
        } else {
          console.log(`SpinDB v${currentVersion}`)
        }
      }
    },
  )
