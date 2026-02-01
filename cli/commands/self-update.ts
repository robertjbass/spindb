import { Command } from 'commander'
import { execSync } from 'child_process'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { updateManager } from '../../core/update-manager'
import { createSpinner } from '../ui/spinner'
import { uiSuccess, uiError, uiInfo, header } from '../ui/theme'

export const selfUpdateCommand = new Command('self-update')
  .alias('update')
  .description('Update spindb to the latest version')
  .option('-f, --force', 'Update even if already on latest version')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(
    async (options: { force?: boolean; yes?: boolean }): Promise<void> => {
      console.log()
      console.log(header('SpinDB Self-Update'))
      console.log()

      const checkSpinner = createSpinner('Checking for updates...')
      checkSpinner.start()

      const result = await updateManager.checkForUpdate(true)

      if (!result) {
        checkSpinner.fail('Could not reach npm registry')
        console.log()
        console.log(uiInfo('Check your internet connection and try again.'))
        const pm = await updateManager.detectPackageManager()
        const manualCmd = updateManager.getInstallCommand(pm)
        console.log(chalk.gray(`  Manual update: ${manualCmd}`))
        process.exit(1)
      }

      if (!result.updateAvailable && !options.force) {
        checkSpinner.succeed('Already on latest version')
        console.log()
        console.log(chalk.gray(`  Current version: ${result.currentVersion}`))
        console.log(chalk.gray(`  Latest version:  ${result.latestVersion}`))
        console.log()
        return
      }

      if (result.updateAvailable) {
        checkSpinner.succeed('Update available')
      } else {
        checkSpinner.succeed('Version check complete')
      }

      console.log()
      console.log(chalk.gray(`  Current version: ${result.currentVersion}`))
      console.log(
        chalk.gray(
          `  Latest version:  ${result.updateAvailable ? chalk.green(result.latestVersion) : result.latestVersion}`,
        ),
      )
      console.log()

      // Confirm unless --yes
      if (!options.yes) {
        const message = result.updateAvailable
          ? `Update spindb from ${result.currentVersion} to ${result.latestVersion}?`
          : `Reinstall spindb ${result.currentVersion}?`

        const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
          {
            type: 'confirm',
            name: 'confirm',
            message,
            default: true,
          },
        ])

        if (!confirm) {
          console.log(chalk.yellow('Update cancelled'))
          return
        }
      }

      console.log()
      const updateSpinner = createSpinner('Updating spindb...')
      updateSpinner.start()

      const updateResult = await updateManager.performUpdate()

      if (updateResult.success) {
        updateSpinner.succeed('Update complete')
        console.log()
        console.log(
          uiSuccess(
            `Updated from ${updateResult.previousVersion} to ${updateResult.newVersion}`,
          ),
        )
        console.log()

        // Verify the new version by running spindb --version in a new process
        // (new process loads the updated code)
        if (updateResult.previousVersion !== updateResult.newVersion) {
          try {
            const versionOutput = execSync('spindb --version', {
              encoding: 'utf-8',
              cwd: '/',
            }).trim()
            console.log(chalk.gray(`  Verified: ${versionOutput}`))
            console.log()
          } catch {
            // Verification failed, but update succeeded
            console.log(
              chalk.gray(
                '  Run "spindb --version" to verify the update.',
              ),
            )
            console.log()
          }
        }
      } else {
        updateSpinner.fail('Update failed')
        console.log()
        console.log(uiError(updateResult.error || 'Unknown error'))
        process.exit(1)
      }
    },
  )
