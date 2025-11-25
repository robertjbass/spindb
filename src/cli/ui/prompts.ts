import inquirer from 'inquirer'
import chalk from 'chalk'
import { listEngines } from '@/engines'
import { defaults } from '@/config/defaults'
import type { ContainerConfig } from '@/types'

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

  const { engine } = await inquirer.prompt<{ engine: string }>([
    {
      type: 'list',
      name: 'engine',
      message: 'Select database engine:',
      choices: engines.map((e) => ({
        name: `${e.displayName} ${chalk.gray(`(versions: ${e.supportedVersions.join(', ')})`)}`,
        value: e.name,
        short: e.displayName,
      })),
    },
  ])

  return engine
}

/**
 * Prompt for PostgreSQL version
 */
export async function promptVersion(engine: string): Promise<string> {
  const engines = listEngines()
  const selectedEngine = engines.find((e) => e.name === engine)
  const versions =
    selectedEngine?.supportedVersions || defaults.supportedPostgresVersions

  const { version } = await inquirer.prompt<{ version: string }>([
    {
      type: 'list',
      name: 'version',
      message: 'Select version:',
      choices: versions.map((v, i) => ({
        name: i === versions.length - 1 ? `${v} ${chalk.green('(latest)')}` : v,
        value: v,
      })),
      default: versions[versions.length - 1], // Default to latest
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
        return true
      },
    },
  ])

  return database
}

export interface CreateOptions {
  name: string
  engine: string
  version: string
}

/**
 * Full interactive create flow
 */
export async function promptCreateOptions(): Promise<CreateOptions> {
  console.log(chalk.cyan('\n  🗄️  Create New Database Container\n'))

  const name = await promptContainerName()
  const engine = await promptEngine()
  const version = await promptVersion(engine)

  return { name, engine, version }
}
