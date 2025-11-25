import inquirer from 'inquirer'
import chalk from 'chalk'
import ora from 'ora'
import { listEngines, getEngine } from '../../engines'
import { defaults } from '../../config/defaults'
import type { ContainerConfig } from '../../types'

/**
 * Prompt for container name
 */
export async function promptContainerName(
  defaultName?: string,
): Promise<string> {
  const { name } = await inquirer.prompt<{ name: string }>([
    {
      type: 'input',
      name: 'name',
      message: 'Container name:',
      default: defaultName,
      validate: (input: string) => {
        if (!input) return 'Name is required'
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
          return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores'
        }
        return true
      },
    },
  ])
  return name
}

/**
 * Prompt for database engine selection
 */
export async function promptEngine(): Promise<string> {
  const engines = listEngines()

  // Build choices from available engines plus coming soon engines
  const choices = [
    ...engines.map((e) => ({
      name: `🐘 ${e.displayName} ${chalk.gray(`(versions: ${e.supportedVersions.join(', ')})`)}`,
      value: e.name,
      short: e.displayName,
    })),
    {
      name: chalk.gray('🐬 MySQL (coming soon)'),
      value: 'mysql',
      disabled: 'Coming soon',
    },
  ]

  const { engine } = await inquirer.prompt<{ engine: string }>([
    {
      type: 'list',
      name: 'engine',
      message: 'Select database engine:',
      choices,
    },
  ])

  return engine
}

/**
 * Prompt for PostgreSQL version
 * Two-step selection: first major version, then specific minor version
 */
export async function promptVersion(engineName: string): Promise<string> {
  const engine = getEngine(engineName)
  const majorVersions = engine.supportedVersions

  // Fetch available versions with a loading indicator
  const spinner = ora({
    text: 'Fetching available versions...',
    color: 'cyan',
  }).start()

  let availableVersions: Record<string, string[]>
  try {
    availableVersions = await engine.fetchAvailableVersions()
    spinner.stop()
  } catch {
    spinner.stop()
    // Fall back to major versions only
    availableVersions = {}
    for (const v of majorVersions) {
      availableVersions[v] = []
    }
  }

  // Step 1: Select major version
  type Choice = {
    name: string
    value: string
    short?: string
  }
  const majorChoices: Choice[] = []

  for (let i = 0; i < majorVersions.length; i++) {
    const major = majorVersions[i]
    const fullVersions = availableVersions[major] || []
    const versionCount = fullVersions.length
    const isLatestMajor = i === majorVersions.length - 1

    const countLabel =
      versionCount > 0 ? chalk.gray(`(${versionCount} versions)`) : ''
    const label = isLatestMajor
      ? `PostgreSQL ${major} ${countLabel} ${chalk.green('← latest')}`
      : `PostgreSQL ${major} ${countLabel}`

    majorChoices.push({
      name: label,
      value: major,
      short: `PostgreSQL ${major}`,
    })
  }

  const { majorVersion } = await inquirer.prompt<{ majorVersion: string }>([
    {
      type: 'list',
      name: 'majorVersion',
      message: 'Select major version:',
      choices: majorChoices,
      default: majorVersions[majorVersions.length - 1], // Default to latest major
    },
  ])

  // Step 2: Select specific version within the major version
  const minorVersions = availableVersions[majorVersion] || []

  if (minorVersions.length === 0) {
    // No versions fetched, return major version (will use fallback)
    return majorVersion
  }

  const minorChoices: Choice[] = minorVersions.map((v, i) => ({
    name: i === 0 ? `${v} ${chalk.green('← latest')}` : v,
    value: v,
    short: v,
  }))

  const { version } = await inquirer.prompt<{ version: string }>([
    {
      type: 'list',
      name: 'version',
      message: `Select PostgreSQL ${majorVersion} version:`,
      choices: minorChoices,
      default: minorVersions[0], // Default to latest
    },
  ])

  return version
}

/**
 * Prompt for port
 */
export async function promptPort(
  defaultPort: number = defaults.port,
): Promise<number> {
  const { port } = await inquirer.prompt<{ port: number }>([
    {
      type: 'input',
      name: 'port',
      message: 'Port:',
      default: String(defaultPort),
      validate: (input: string) => {
        const num = parseInt(input, 10)
        if (isNaN(num) || num < 1 || num > 65535) {
          return 'Port must be a number between 1 and 65535'
        }
        return true
      },
      filter: (input: string) => parseInt(input, 10),
    },
  ])

  return port
}

/**
 * Prompt for confirmation using arrow-key selection
 */
export async function promptConfirm(
  message: string,
  defaultValue: boolean = true,
): Promise<boolean> {
  const { confirmed } = await inquirer.prompt<{ confirmed: string }>([
    {
      type: 'list',
      name: 'confirmed',
      message,
      choices: [
        { name: 'Yes', value: 'yes' },
        { name: 'No', value: 'no' },
      ],
      default: defaultValue ? 'yes' : 'no',
    },
  ])

  return confirmed === 'yes'
}

/**
 * Prompt for container selection from a list
 */
export async function promptContainerSelect(
  containers: ContainerConfig[],
  message: string = 'Select container:',
): Promise<string | null> {
  if (containers.length === 0) {
    return null
  }

  const { container } = await inquirer.prompt<{ container: string }>([
    {
      type: 'list',
      name: 'container',
      message,
      choices: containers.map((c) => ({
        name: `${c.name} ${chalk.gray(`(${c.engine} ${c.version}, port ${c.port})`)} ${
          c.status === 'running'
            ? chalk.green('● running')
            : chalk.gray('○ stopped')
        }`,
        value: c.name,
        short: c.name,
      })),
    },
  ])

  return container
}

/**
 * Prompt for database name
 */
export async function promptDatabaseName(
  defaultName?: string,
): Promise<string> {
  const { database } = await inquirer.prompt<{ database: string }>([
    {
      type: 'input',
      name: 'database',
      message: 'Database name:',
      default: defaultName,
      validate: (input: string) => {
        if (!input) return 'Database name is required'
        // PostgreSQL database naming rules
        if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(input)) {
          return 'Database name must start with a letter or underscore and contain only letters, numbers, underscores, and hyphens'
        }
        if (input.length > 63) {
          return 'Database name must be 63 characters or less'
        }
        return true
      },
    },
  ])

  return database
}

export type CreateOptions = {
  name: string
  engine: string
  version: string
  port: number
  database: string
}

/**
 * Full interactive create flow
 */
export async function promptCreateOptions(
  defaultPort: number = defaults.port,
): Promise<CreateOptions> {
  console.log(chalk.cyan('\n  🗄️  Create New Database Container\n'))

  const engine = await promptEngine()
  const version = await promptVersion(engine)
  const name = await promptContainerName()
  const database = await promptDatabaseName(name) // Default to container name
  const port = await promptPort(defaultPort)

  return { name, engine, version, port, database }
}
