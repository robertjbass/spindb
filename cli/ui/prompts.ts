import inquirer from 'inquirer'
import chalk from 'chalk'
import ora from 'ora'
import { listEngines, getEngine } from '../../engines'
import { defaults, getEngineDefaults } from '../../config/defaults'
import { installPostgresBinaries } from '../../core/postgres-binary-manager'
import {
  detectPackageManager,
  getManualInstallInstructions,
  getCurrentPlatform,
  installEngineDependencies,
} from '../../core/dependency-manager'
import { getEngineDependencies } from '../../config/os-dependencies'
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
 * Engine icons for display
 */
const engineIcons: Record<string, string> = {
  postgresql: '🐘',
  mysql: '🐬',
}

/**
 * Prompt for database engine selection
 */
export async function promptEngine(): Promise<string> {
  const engines = listEngines()

  // Build choices from available engines
  const choices = engines.map((e) => ({
    name: `${engineIcons[e.name] || '🗄️'} ${e.displayName} ${chalk.gray(`(versions: ${e.supportedVersions.join(', ')})`)}`,
    value: e.name,
    short: e.displayName,
  }))

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
 * Prompt for database version
 * Two-step selection: first major version, then specific minor version (if available)
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
      ? `${engine.displayName} ${major} ${countLabel} ${chalk.green('← latest')}`
      : `${engine.displayName} ${major} ${countLabel}`

    majorChoices.push({
      name: label,
      value: major,
      short: `${engine.displayName} ${major}`,
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
      message: `Select ${engine.displayName} ${majorVersion} version:`,
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
        name: `${c.name} ${chalk.gray(`(${engineIcons[c.engine] || '🗄️'} ${c.engine} ${c.version}, port ${c.port})`)} ${
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
export async function promptCreateOptions(): Promise<CreateOptions> {
  console.log(chalk.cyan('\n  🗄️  Create New Database Container\n'))

  const engine = await promptEngine()
  const version = await promptVersion(engine)
  const name = await promptContainerName()
  const database = await promptDatabaseName(name) // Default to container name

  // Get engine-specific default port
  const engineDefaults = getEngineDefaults(engine)
  const port = await promptPort(engineDefaults.defaultPort)

  return { name, engine, version, port, database }
}

/**
 * Prompt user to install missing database client tools
 * Returns true if installation was successful or user declined, false if installation failed
 *
 * @param missingTool - The name of the missing tool (e.g., 'psql', 'pg_dump', 'mysql')
 * @param engine - The database engine (defaults to 'postgresql')
 */
export async function promptInstallDependencies(
  missingTool: string,
  engine: string = 'postgresql',
): Promise<boolean> {
  const platform = getCurrentPlatform()

  console.log()
  console.log(
    chalk.yellow(`  Database client tool "${missingTool}" is not installed.`),
  )
  console.log()

  // Check what package manager is available
  const packageManager = await detectPackageManager()

  if (!packageManager) {
    console.log(chalk.red('  No supported package manager found.'))
    console.log()

    // Get instructions from the dependency registry
    const engineDeps = getEngineDependencies(engine)
    if (engineDeps) {
      // Find the specific dependency or use the first one for general instructions
      const dep =
        engineDeps.dependencies.find((d) => d.binary === missingTool) ||
        engineDeps.dependencies[0]

      if (dep) {
        const instructions = getManualInstallInstructions(dep, platform)
        console.log(
          chalk.gray(`  Please install ${engineDeps.displayName} client tools:`),
        )
        console.log()
        for (const instruction of instructions) {
          console.log(chalk.gray(`    ${instruction}`))
        }
      }
    }
    console.log()
    return false
  }

  console.log(
    chalk.gray(`  Detected package manager: ${chalk.white(packageManager.name)}`),
  )
  console.log()

  // Get engine display name
  const engineDeps = getEngineDependencies(engine)
  const engineName = engineDeps?.displayName || engine

  const { shouldInstall } = await inquirer.prompt<{ shouldInstall: string }>([
    {
      type: 'list',
      name: 'shouldInstall',
      message: `Would you like to install ${engineName} client tools now?`,
      choices: [
        { name: 'Yes, install now', value: 'yes' },
        { name: 'No, I will install manually', value: 'no' },
      ],
      default: 'yes',
    },
  ])

  if (shouldInstall === 'no') {
    console.log()
    console.log(chalk.gray('  To install manually, run:'))

    // Get the specific dependency and build install command info
    if (engineDeps) {
      const dep = engineDeps.dependencies.find((d) => d.binary === missingTool)
      if (dep) {
        const pkgDef = dep.packages[packageManager.id]
        if (pkgDef) {
          const installCmd = packageManager.config.installTemplate.replace(
            '{package}',
            pkgDef.package,
          )
          console.log(chalk.cyan(`    ${installCmd}`))
          if (pkgDef.postInstall) {
            for (const postCmd of pkgDef.postInstall) {
              console.log(chalk.cyan(`    ${postCmd}`))
            }
          }
        }
      }
    }
    console.log()
    return false
  }

  console.log()

  // PostgreSQL has its own install function with extra logic
  if (engine === 'postgresql') {
    const success = await installPostgresBinaries()

    if (success) {
      console.log()
      console.log(
        chalk.green(`  ${engineName} client tools installed successfully!`),
      )
      console.log(chalk.gray('  Continuing with your operation...'))
      console.log()
    }

    return success
  }

  // For other engines (MySQL, etc.), use the generic installer
  console.log(
    chalk.cyan(`  Installing ${engineName} with ${packageManager.name}...`),
  )
  console.log(chalk.gray('  You may be prompted for your password.'))
  console.log()

  try {
    const results = await installEngineDependencies(engine, packageManager)
    const allSuccess = results.every((r) => r.success)

    if (allSuccess) {
      console.log()
      console.log(
        chalk.green(`  ${engineName} tools installed successfully!`),
      )
      console.log(chalk.gray('  Continuing with your operation...'))
      console.log()
      return true
    } else {
      const failed = results.filter((r) => !r.success)
      console.log()
      console.log(chalk.red('  Some installations failed:'))
      for (const f of failed) {
        console.log(chalk.red(`    ${f.dependency.name}: ${f.error}`))
      }
      console.log()

      // Show manual install instructions
      if (engineDeps) {
        const instructions = getManualInstallInstructions(
          engineDeps.dependencies[0],
          platform,
        )
        if (instructions.length > 0) {
          console.log(chalk.gray('  To install manually:'))
          for (const instruction of instructions) {
            console.log(chalk.gray(`    ${instruction}`))
          }
          console.log()
        }
      }

      return false
    }
  } catch (err) {
    const e = err as Error
    console.log()
    console.log(chalk.red(`  Installation failed: ${e.message}`))
    console.log()

    // Show manual install instructions on error
    if (engineDeps) {
      const instructions = getManualInstallInstructions(
        engineDeps.dependencies[0],
        platform,
      )
      if (instructions.length > 0) {
        console.log(chalk.gray('  To install manually:'))
        for (const instruction of instructions) {
          console.log(chalk.gray(`    ${instruction}`))
        }
        console.log()
      }
    }

    return false
  }
}
