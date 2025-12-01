import chalk from 'chalk'
import inquirer from 'inquirer'
import { spawn } from 'child_process'
import { containerManager } from '../../../core/container-manager'
import {
  isUsqlInstalled,
  isPgcliInstalled,
  isMycliInstalled,
  detectPackageManager,
  installUsql,
  installPgcli,
  installMycli,
  getUsqlManualInstructions,
  getPgcliManualInstructions,
  getMycliManualInstructions,
} from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { getEngine } from '../../../engines'
import { createSpinner } from '../../ui/spinner'
import { error, warning, info, success } from '../../ui/theme'
import { pressEnterToContinue } from './shared'

export async function handleCopyConnectionString(
  containerName: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)
  const connectionString = engine.getConnectionString(config)

  const copied = await platformService.copyToClipboard(connectionString)

  console.log()
  if (copied) {
    console.log(success('Connection string copied to clipboard'))
    console.log(chalk.gray(`  ${connectionString}`))
  } else {
    console.log(warning('Could not copy to clipboard. Connection string:'))
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
    console.error(error(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)
  const connectionString = engine.getConnectionString(config)

  const shellCheckSpinner = createSpinner('Checking available shells...')
  shellCheckSpinner.start()

  const [usqlInstalled, pgcliInstalled, mycliInstalled] = await Promise.all([
    isUsqlInstalled(),
    isPgcliInstalled(),
    isMycliInstalled(),
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
    | 'back'

  const defaultShellName = config.engine === 'mysql' ? 'mysql' : 'psql'
  const engineSpecificCli = config.engine === 'mysql' ? 'mycli' : 'pgcli'
  const engineSpecificInstalled =
    config.engine === 'mysql' ? mycliInstalled : pgcliInstalled

  const choices: Array<{ name: string; value: ShellChoice } | inquirer.Separator> = [
    {
      name: `>_ Use default shell (${defaultShellName})`,
      value: 'default',
    },
  ]

  if (engineSpecificInstalled) {
    choices.push({
      name: `⚡ Use ${engineSpecificCli} (enhanced features, recommended)`,
      value: config.engine === 'mysql' ? 'mycli' : 'pgcli',
    })
  } else {
    choices.push({
      name: `↓ Install ${engineSpecificCli} (enhanced features, recommended)`,
      value: config.engine === 'mysql' ? 'install-mycli' : 'install-pgcli',
    })
  }

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
    console.log(info('Installing pgcli for enhanced PostgreSQL shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installPgcli(pm)
      if (result.success) {
        console.log(success('pgcli installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'pgcli')
      } else {
        console.error(error(`Failed to install pgcli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getPgcliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(error('No supported package manager found'))
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
    console.log(info('Installing mycli for enhanced MySQL shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installMycli(pm)
      if (result.success) {
        console.log(success('mycli installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'mycli')
      } else {
        console.error(error(`Failed to install mycli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getMycliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(error('No supported package manager found'))
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
    console.log(info('Installing usql for enhanced shell experience...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installUsql(pm)
      if (result.success) {
        console.log(success('usql installed successfully!'))
        console.log()
        await launchShell(containerName, config, connectionString, 'usql')
      } else {
        console.error(error(`Failed to install usql: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getUsqlManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(error('No supported package manager found'))
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

  await launchShell(containerName, config, connectionString, shellChoice)
}

async function launchShell(
  containerName: string,
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>,
  connectionString: string,
  shellType: 'default' | 'usql' | 'pgcli' | 'mycli',
): Promise<void> {
  console.log(info(`Connecting to ${containerName}...`))
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
  } else if (shellType === 'usql') {
    // usql accepts connection strings directly for both PostgreSQL and MySQL
    shellCmd = 'usql'
    shellArgs = [connectionString]
    installHint = 'brew tap xo/xo && brew install xo/xo/usql'
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
  } else {
    shellCmd = 'psql'
    shellArgs = [connectionString]
    installHint = 'brew install libpq && brew link --force libpq'
  }

  const shellProcess = spawn(shellCmd, shellArgs, {
    stdio: 'inherit',
  })

  shellProcess.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      console.log(warning(`${shellCmd} not found on your system.`))
      console.log()
      console.log(chalk.gray('  Connect manually with:'))
      console.log(chalk.cyan(`  ${connectionString}`))
      console.log()
      console.log(chalk.gray(`  Install ${shellCmd}:`))
      console.log(chalk.cyan(`  ${installHint}`))
    }
  })

  await new Promise<void>((resolve) => {
    shellProcess.on('close', () => resolve())
  })
}
