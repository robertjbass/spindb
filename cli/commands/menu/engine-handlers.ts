import chalk from 'chalk'
import inquirer from 'inquirer'
import { rm } from 'fs/promises'
import stringWidth from 'string-width'
import { containerManager } from '../../../core/container-manager'
import { createSpinner } from '../../ui/spinner'
import { header, uiError, uiWarning, uiInfo, formatBytes } from '../../ui/theme'
import { promptConfirm } from '../../ui/prompts'
import { getEngineIcon } from '../../constants'
import {
  getInstalledEngines,
  type InstalledPostgresEngine,
  type InstalledMariadbEngine,
  type InstalledMysqlEngine,
  type InstalledSqliteEngine,
  type InstalledDuckDBEngine,
  type InstalledMongodbEngine,
  type InstalledRedisEngine,
  type InstalledValkeyEngine,
  type InstalledClickHouseEngine,
  type InstalledQdrantEngine,
} from '../../helpers'

import { type MenuChoice } from './shared'

// Pad string to target visual width, accounting for Unicode character widths
function padToWidth(str: string, targetWidth: number): string {
  const currentWidth = stringWidth(str)
  const padding = Math.max(0, targetWidth - currentWidth)
  return str + ' '.repeat(padding)
}

export async function handleEngines(): Promise<void> {
  console.clear()
  console.log(header('Installed Engines'))
  console.log()

  const engines = await getInstalledEngines()

  if (engines.length === 0) {
    console.log(uiInfo('No engines installed yet.'))
    console.log(
      chalk.gray(
        '  Database engines are downloaded automatically when you create a container.',
      ),
    )
    console.log(
      chalk.gray('  Or use: spindb engines download <engine> <version>'),
    )
    return
  }

  // Group engines by type and sort
  const allEnginesSorted = [
    ...engines.filter(
      (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
    ),
    ...engines.filter((e): e is InstalledMariadbEngine => e.engine === 'mariadb'),
    ...engines.filter((e): e is InstalledMysqlEngine => e.engine === 'mysql'),
    ...engines.filter((e): e is InstalledSqliteEngine => e.engine === 'sqlite'),
    ...engines.filter((e): e is InstalledDuckDBEngine => e.engine === 'duckdb'),
    ...engines.filter((e): e is InstalledMongodbEngine => e.engine === 'mongodb'),
    ...engines.filter((e): e is InstalledRedisEngine => e.engine === 'redis'),
    ...engines.filter((e): e is InstalledValkeyEngine => e.engine === 'valkey'),
    ...engines.filter(
      (e): e is InstalledClickHouseEngine => e.engine === 'clickhouse',
    ),
    ...engines.filter((e): e is InstalledQdrantEngine => e.engine === 'qdrant'),
  ]

  // Calculate total size
  const totalSize = allEnginesSorted.reduce((acc, e) => acc + e.sizeBytes, 0)

  // Column widths for formatting
  const COL_ENGINE = 13
  const COL_VERSION = 12
  const COL_PLATFORM = 14
  const COL_SIZE = 10

  // Build selectable choices with formatted display
  const choices: MenuChoice[] = allEnginesSorted.map((e) => {
    const icon = getEngineIcon(e.engine)
    const engineDisplay = padToWidth(`${icon} ${e.engine}`, COL_ENGINE)
    const versionDisplay = e.version.padEnd(COL_VERSION)
    const platformDisplay = `${e.platform}-${e.arch}`.padEnd(COL_PLATFORM)
    const sizeDisplay = formatBytes(e.sizeBytes).padStart(COL_SIZE)

    return {
      name:
        chalk.cyan(engineDisplay) +
        chalk.yellow(versionDisplay) +
        chalk.gray(platformDisplay) +
        chalk.white(sizeDisplay),
      value: `select:${e.path}:${e.engine}:${e.version}:${e.sizeBytes}`,
      short: `${e.engine} ${e.version}`,
    }
  })

  choices.push(new inquirer.Separator(chalk.gray('─'.repeat(52))))
  choices.push(
    new inquirer.Separator(
      chalk.gray(`Total: ${engines.length} engine(s), ${formatBytes(totalSize)}`),
    ),
  )
  choices.push(new inquirer.Separator())
  choices.push({ name: `${chalk.blue('←')} Back to main menu`, value: 'back' })

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select an engine:',
      choices,
      pageSize: 18,
    },
  ])

  if (action === 'back') {
    return
  }

  if (action.startsWith('select:')) {
    // Parse from the end using lastIndexOf to correctly handle colons in Windows
    // paths (e.g., C:\Users\...). Format: select:path:engineName:engineVersion:sizeBytes
    // We extract sizeBytes first, then version, then name, leaving path with any colons intact.
    const withoutPrefix = action.slice('select:'.length)
    const lastColon = withoutPrefix.lastIndexOf(':')
    const sizeBytes = parseInt(withoutPrefix.slice(lastColon + 1), 10)
    const rest = withoutPrefix.slice(0, lastColon)
    const secondLastColon = rest.lastIndexOf(':')
    const engineVersion = rest.slice(secondLastColon + 1)
    const rest2 = rest.slice(0, secondLastColon)
    const thirdLastColon = rest2.lastIndexOf(':')
    const engineName = rest2.slice(thirdLastColon + 1)
    const enginePath = rest2.slice(0, thirdLastColon)

    const result = await showEngineSubmenu(
      enginePath,
      engineName,
      engineVersion,
      sizeBytes,
    )
    if (result === 'main') {
      return
    }
    await handleEngines()
  }
}

async function showEngineSubmenu(
  enginePath: string,
  engineName: string,
  engineVersion: string,
  sizeBytes: number,
): Promise<'back' | 'main' | void> {
  console.log()
  console.log(
    chalk.cyan(
      `  ${getEngineIcon(engineName)} ${engineName} ${engineVersion} ${chalk.gray(`(${formatBytes(sizeBytes)})`)}`,
    ),
  )
  console.log()

  const choices: MenuChoice[] = [
    {
      name: `${chalk.red('✕')} Delete`,
      value: 'delete',
    },
    new inquirer.Separator(),
    { name: `${chalk.blue('←')} Back`, value: 'back' },
    { name: `${chalk.blue('⌂')} Back to main menu`, value: 'main' },
  ]

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices,
    },
  ])

  if (action === 'back') {
    return 'back'
  }

  if (action === 'main') {
    return 'main'
  }

  if (action === 'delete') {
    await handleDeleteEngine(enginePath, engineName, engineVersion)
  }
}

async function handleDeleteEngine(
  enginePath: string,
  engineName: string,
  engineVersion: string,
): Promise<void> {
  const containers = await containerManager.list()
  const usingContainers = containers.filter(
    (c) => c.engine === engineName && c.version === engineVersion,
  )

  if (usingContainers.length > 0) {
    console.log()
    console.log(
      uiError(
        `Cannot delete: ${usingContainers.length} container(s) are using ${engineName} ${engineVersion}`,
      ),
    )
    console.log(
      chalk.gray(
        `  Containers: ${usingContainers.map((c) => c.name).join(', ')}`,
      ),
    )
    console.log()
    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('Press Enter to continue...'),
      },
    ])
    return
  }

  const confirmed = await promptConfirm(
    `Delete ${engineName} ${engineVersion}? This cannot be undone.`,
    false,
  )

  if (!confirmed) {
    console.log(uiWarning('Deletion cancelled'))
    return
  }

  const spinner = createSpinner(`Deleting ${engineName} ${engineVersion}...`)
  spinner.start()

  try {
    await rm(enginePath, { recursive: true, force: true })
    spinner.succeed(`Deleted ${engineName} ${engineVersion}`)
  } catch (error) {
    const e = error as Error
    spinner.fail(`Failed to delete: ${e.message}`)
  }
}
