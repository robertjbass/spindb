import chalk from 'chalk'
import inquirer from 'inquirer'
import { spawn } from 'child_process'
import { containerManager } from '../../../core/container-manager'
import {
  isUsqlInstalled,
  isPgcliInstalled,
  isMycliInstalled,
  isLitecliInstalled,
  detectPackageManager,
  installUsql,
  installPgcli,
  installMycli,
  installLitecli,
  getUsqlManualInstructions,
  getPgcliManualInstructions,
  getMycliManualInstructions,
  getLitecliManualInstructions,
} from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { getEngine } from '../../../engines'
import { createSpinner } from '../../ui/spinner'
import { uiError, uiWarning, uiInfo, uiSuccess } from '../../ui/theme'
import { pressEnterToContinue } from './shared'

export async function handleCopyConnectionString(
  containerName: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)
  const connectionString = engine.getConnectionString(config)

  const copied = await platformService.copyToClipboard(connectionString)

  console.log()
  if (copied) {
    console.log(uiSuccess('Connection string copied to clipboard'))
    console.log(chalk.gray(`  ${connectionString}`))
  } else {
    console.log(uiWarning('Could not copy to clipboard. Connection string:'))
    console.log(chalk.cyan(`  ${connectionString}`))
  }
  console.log()

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to continue...'),
    },
  ])
}

export async function handleOpenShell(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)
  const connectionString = engine.getConnectionString(config)

  const shellCheckSpinner = createSpinner('Checking available shells...')
  shellCheckSpinner.start()

  const [usqlInstalled, pgcliInstalled, mycliInstalled, litecliInstalled] =
    await Promise.all([
      isUsqlInstalled(),
      isPgcliInstalled(),
      isMycliInstalled(),
      isLitecliInstalled(),
    ])

  shellCheckSpinner.stop()
  // Clear the spinner line
  process.stdout.write('\x1b[1A\x1b[2K')

  type ShellChoice =
    | 'default'
    | 'usql'
    | 'install-usql'
    | 'pgcli'
    | 'install-pgcli'
    | 'mycli'
    | 'install-mycli'
    | 'litecli'
    | 'install-litecli'
    | 'back'

  // Engine-specific shell names
  let defaultShellName: string
  let engineSpecificCli: string | null
  let engineSpecificInstalled: boolean
  let engineSpecificValue: ShellChoice | null
  let engineSpecificInstallValue: ShellChoice | null

  if (config.engine === 'sqlite') {
    defaultShellName = 'sqlite3'
    engineSpecificCli = 'litecli'
    engineSpecificInstalled = litecliInstalled
    engineSpecificValue = 'litecli'
    engineSpecificInstallValue = 'install-litecli'
  } else if (config.engine === 'mysql') {
    defaultShellName = 'mysql'
    engineSpecificCli = 'mycli'
    engineSpecificInstalled = mycliInstalled
    engineSpecificValue = 'mycli'
    engineSpecificInstallValue = 'install-mycli'
  } else if (config.engine === 'mongodb') {
    defaultShellName = 'mongosh'
    // mongosh IS the enhanced shell for MongoDB (no separate enhanced CLI like pgcli/mycli)
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else {
    defaultShellName = 'psql'
    engineSpecificCli = 'pgcli'
    engineSpecificInstalled = pgcliInstalled
    engineSpecificValue = 'pgcli'
    engineSpecificInstallValue = 'install-pgcli'
  }

  const choices: Array<
    { name: string; value: ShellChoice } | inquirer.Separator
  > = [
    {
      name: `>_ Use default shell (${defaultShellName})`,
      value: 'default',
    },
  ]

  // Only show engine-specific CLI option if one exists (MongoDB's mongosh IS the default)
  if (engineSpecificCli !== null) {
    if (engineSpecificInstalled) {
      choices.push({
        name: `⚡ Use ${engineSpecificCli} (enhanced features, recommended)`,
        value: engineSpecificValue!,
      })
    } else {
      choices.push({
        name: `↓ Install ${engineSpecificCli} (enhanced features, recommended)`,
        value: engineSpecificInstallValue!,
      })
    }
  }

  // usql supports SQLite too
  if (usqlInstalled) {
    choices.push({
      name: '⚡ Use usql (universal SQL client)',
      value: 'usql',
    })
  } else {
    choices.push({
      name: '↓ Install usql (universal SQL client)',
      value: 'install-usql',
    })
  }

  choices.push(new inquirer.Separator())
  choices.push({
    name: `${chalk.blue('←')} Back`,
    value: 'back',
  })

  const { shellChoice } = await inquirer.prompt<{ shellChoice: ShellChoice }>([
    {
      type: 'list',
      name: 'shellChoice',
      message: 'Select shell option:',
      choices,
      pageSize: 10,
    },
  ])

  if (shellChoice === 'back') {
    return
  }

  if (shellChoice === 'install-pgcli') {
    console.log()
    console.log(uiInfo('Installing pgcli for enhanced PostgreSQL shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installPgcli(pm)
      if (result.success) {
        console.log(uiSuccess('pgcli installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'pgcli')
      } else {
        console.error(uiError(`Failed to install pgcli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getPgcliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getPgcliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-mycli') {
    console.log()
    console.log(uiInfo('Installing mycli for enhanced MySQL shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installMycli(pm)
      if (result.success) {
        console.log(uiSuccess('mycli installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'mycli')
      } else {
        console.error(uiError(`Failed to install mycli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getMycliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getMycliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-usql') {
    console.log()
    console.log(uiInfo('Installing usql for enhanced shell experience...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installUsql(pm)
      if (result.success) {
        console.log(uiSuccess('usql installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'usql')
      } else {
        console.error(uiError(`Failed to install usql: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getUsqlManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getUsqlManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-litecli') {
    console.log()
    console.log(uiInfo('Installing litecli for enhanced SQLite shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installLitecli(pm)
      if (result.success) {
        console.log(uiSuccess('litecli installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'litecli')
      } else {
        console.error(uiError(`Failed to install litecli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getLitecliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getLitecliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  await launchShell(containerName, config, connectionString, shellChoice)
}

async function launchShell(
  containerName: string,
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>,
  connectionString: string,
  shellType: 'default' | 'usql' | 'pgcli' | 'mycli' | 'litecli',
): Promise<void> {
  console.log(uiInfo(`Connecting to ${containerName}...`))
  console.log()

  let shellCmd: string
  let shellArgs: string[]
  let installHint: string

  if (shellType === 'pgcli') {
    // pgcli accepts connection strings
    shellCmd = 'pgcli'
    shellArgs = [connectionString]
    installHint = 'brew install pgcli'
  } else if (shellType === 'mycli') {
    // mycli: mycli -h host -P port -u user database
    shellCmd = 'mycli'
    shellArgs = [
      '-h',
      '127.0.0.1',
      '-P',
      String(config.port),
      '-u',
      'root',
      config.database,
    ]
    installHint = 'brew install mycli'
  } else if (shellType === 'litecli') {
    // litecli takes the database file path directly
    shellCmd = 'litecli'
    shellArgs = [config.database]
    installHint = 'brew install litecli'
  } else if (shellType === 'usql') {
    // usql accepts connection strings directly for PostgreSQL, MySQL, and SQLite
    shellCmd = 'usql'
    shellArgs = [connectionString]
    installHint = 'brew tap xo/xo && brew install xo/xo/usql'
  } else if (config.engine === 'sqlite') {
    // Default SQLite shell
    shellCmd = 'sqlite3'
    shellArgs = [config.database]
    installHint = 'brew install sqlite3'
  } else if (config.engine === 'mysql') {
    shellCmd = 'mysql'
    shellArgs = [
      '-u',
      'root',
      '-h',
      '127.0.0.1',
      '-P',
      String(config.port),
      config.database,
    ]
    installHint = 'brew install mysql-client'
  } else if (config.engine === 'mongodb') {
    shellCmd = 'mongosh'
    shellArgs = [connectionString]
    installHint = 'brew install mongosh'
  } else {
    shellCmd = 'psql'
    shellArgs = [connectionString]
    installHint = 'brew install libpq && brew link --force libpq'
  }

  const shellProcess = spawn(shellCmd, shellArgs, {
    stdio: 'inherit',
  })

  await new Promise<void>((resolve) => {
    let settled = false

    const settle = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }

    shellProcess.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.log(uiWarning(`${shellCmd} not found on your system.`))
        console.log()
        console.log(chalk.gray('  Connect manually with:'))
        console.log(chalk.cyan(`  ${connectionString}`))
        console.log()
        console.log(chalk.gray(`  Install ${shellCmd}:`))
        console.log(chalk.cyan(`  ${installHint}`))
      } else {
        console.log(uiError(`Failed to start ${shellCmd}: ${err.message}`))
      }
      settle()
    })

    shellProcess.on('close', settle)
  })
}
