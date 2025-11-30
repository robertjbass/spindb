import chalk from 'chalk'
import inquirer from 'inquirer'
import { updateManager } from '../../../core/update-manager'
import { createSpinner } from '../../ui/spinner'
import { header, success, error, warning, info } from '../../ui/theme'
import { pressEnterToContinue } from './shared'

export async function handleCheckUpdate(): Promise<void> {
  console.clear()
  console.log(header('Check for Updates'))
  console.log()

  const spinner = createSpinner('Checking for updates...')
  spinner.start()

  const result = await updateManager.checkForUpdate(true)

  if (!result) {
    spinner.fail('Could not reach npm registry')
    console.log()
    console.log(info('Check your internet connection and try again.'))
    console.log(chalk.gray('  Manual update: npm install -g spindb@latest'))
    console.log()
    await pressEnterToContinue()
    return
  }

  if (result.updateAvailable) {
    spinner.succeed('Update available')
    console.log()
    console.log(chalk.gray(`  Current version: ${result.currentVersion}`))
    console.log(
      chalk.gray(`  Latest version:  ${chalk.green(result.latestVersion)}`),
    )
    console.log()

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Update now', value: 'update' },
          { name: 'Remind me later', value: 'later' },
          { name: "Don't check for updates on startup", value: 'disable' },
        ],
      },
    ])

    if (action === 'update') {
      console.log()
      const updateSpinner = createSpinner('Updating spindb...')
      updateSpinner.start()

      const updateResult = await updateManager.performUpdate()

      if (updateResult.success) {
        updateSpinner.succeed('Update complete')
        console.log()
        console.log(
          success(
            `Updated from ${updateResult.previousVersion} to ${updateResult.newVersion}`,
          ),
        )
        console.log()
        if (updateResult.previousVersion !== updateResult.newVersion) {
          console.log(warning('Please restart spindb to use the new version.'))
          console.log()
        }
      } else {
        updateSpinner.fail('Update failed')
        console.log()
        console.log(error(updateResult.error || 'Unknown error'))
        console.log()
        console.log(info('Manual update: npm install -g spindb@latest'))
      }
      await pressEnterToContinue()
    } else if (action === 'disable') {
      await updateManager.setAutoCheckEnabled(false)
      console.log()
      console.log(info('Update checks disabled on startup.'))
      console.log(chalk.gray('  Re-enable with: spindb config update-check on'))
      console.log()
      await pressEnterToContinue()
    }
    // 'later' just returns to menu
  } else {
    spinner.succeed('You are on the latest version')
    console.log()
    console.log(chalk.gray(`  Version: ${result.currentVersion}`))
    console.log()
    await pressEnterToContinue()
  }
}
