import inquirer from 'inquirer'
import chalk from 'chalk'
import ora from 'ora'
import { existsSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { listEngines, getEngine } from '../../engines'
import { defaults, getEngineDefaults } from '../../config/defaults'
import { installPostgresBinaries } from '../../engines/postgresql/binary-manager'
import { portManager } from '../../core/port-manager'
import { containerManager } from '../../core/container-manager'
import {
  detectPackageManager,
  getManualInstallInstructions,
  getCurrentPlatform,
  installEngineDependencies,
} from '../../core/dependency-manager'
import { getEngineDependencies } from '../../config/os-dependencies'
import { getEngineIcon } from '../constants'
import type { ContainerConfig } from '../../types'

// Navigation sentinel values for menu navigation
export const BACK_VALUE = '__back__'
export const MAIN_MENU_VALUE = '__main__'

/**
 * Prompt for container name
 * @param defaultName - Default value for the container name
 * @param options.allowBack - Allow empty input to go back (returns null)
 */
export function promptContainerName(
  defaultName?: string,
  options?: { allowBack?: false },
): Promise<string>
export function promptContainerName(
  defaultName: string | undefined,
  options: { allowBack: true },
): Promise<string | null>
export async function promptContainerName(
  defaultName?: string,
  options?: { allowBack?: boolean },
): Promise<string | null> {
  const { name } = await inquirer.prompt<{ name: string }>([
    {
      type: 'input',
      name: 'name',
      message: 'Container name:',
      default: options?.allowBack ? undefined : defaultName,
      validate: (input: string) => {
        if (options?.allowBack && !input) return true // Allow empty for back
        if (!input) return 'Name is required'
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
          return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores'
        }
        return true
      },
    },
  ])

  if (options?.allowBack && !name) return null
  return name
}

/**
 * Prompt for database engine selection
 * @param options.includeBack - Include back/main menu navigation options
 * @returns Engine name, or BACK_VALUE/MAIN_MENU_VALUE for navigation
 */
export async function promptEngine(options?: {
  includeBack?: boolean
}): Promise<string> {
  const engines = listEngines()

  type Choice =
    | { name: string; value: string; short?: string }
    | inquirer.Separator

  const choices: Choice[] = engines.map((e) => ({
    name: `${getEngineIcon(e.name)} ${e.displayName} ${chalk.gray(`(versions: ${e.supportedVersions.join(', ')})`)}`,
    value: e.name,
    short: e.displayName,
  }))

  if (options?.includeBack) {
    choices.push(new inquirer.Separator())
    choices.push({ name: `${chalk.blue('←')} Back`, value: BACK_VALUE })
    choices.push({
      name: `${chalk.blue('⌂')} Back to main menu`,
      value: MAIN_MENU_VALUE,
    })
  }

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
 * @param options.includeBack - Include back/main menu navigation options
 * @returns Version string, or BACK_VALUE/MAIN_MENU_VALUE for navigation
 */
export async function promptVersion(
  engineName: string,
  options?: { includeBack?: boolean },
): Promise<string> {
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
  type Choice =
    | { name: string; value: string; short?: string }
    | inquirer.Separator

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

  if (options?.includeBack) {
    majorChoices.push(new inquirer.Separator())
    majorChoices.push({ name: `${chalk.blue('←')} Back`, value: BACK_VALUE })
    majorChoices.push({
      name: `${chalk.blue('⌂')} Back to main menu`,
      value: MAIN_MENU_VALUE,
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

  // Handle navigation
  if (majorVersion === BACK_VALUE || majorVersion === MAIN_MENU_VALUE) {
    return majorVersion
  }

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

  if (options?.includeBack) {
    minorChoices.push(new inquirer.Separator())
    minorChoices.push({
      name: `${chalk.blue('←')} Back to major versions`,
      value: BACK_VALUE,
    })
    minorChoices.push({
      name: `${chalk.blue('⌂')} Back to main menu`,
      value: MAIN_MENU_VALUE,
    })
  }

  const { version } = await inquirer.prompt<{ version: string }>([
    {
      type: 'list',
      name: 'version',
      message: `Select ${engine.displayName} ${majorVersion} version:`,
      choices: minorChoices,
      default: minorVersions[0], // Default to latest
    },
  ])

  // Handle navigation from minor version selection
  if (version === BACK_VALUE) {
    // Go back to major version selection (recursive call)
    return promptVersion(engineName, options)
  }
  if (version === MAIN_MENU_VALUE) {
    return MAIN_MENU_VALUE
  }

  return version
}

/**
 * Prompt for port with conflict detection
 * @param defaultPort - Default port number
 * @param engine - Engine name for port range lookup
 */
export async function promptPort(
  defaultPort: number = defaults.port,
  engine?: string,
): Promise<number> {
  // Get engine-specific port range
  const portRange = engine
    ? getEngineDefaults(engine).portRange
    : defaults.portRange

  // Get all existing container ports for conflict detection
  const existingContainers = await containerManager.list()
  const containerPorts = new Map<number, string>()
  for (const c of existingContainers) {
    if (c.port > 0) {
      containerPorts.set(c.port, c.name)
    }
  }

  // Check if default port has a conflict and find a better default
  let suggestedPort = defaultPort
  const defaultPortContainer = containerPorts.get(defaultPort)
  const defaultPortInUse =
    !defaultPortContainer && !(await portManager.isPortAvailable(defaultPort))

  if (defaultPortContainer || defaultPortInUse) {
    // Find next available port in the engine's port range
    try {
      const result = await portManager.findAvailablePortExcludingContainers({
        preferredPort: defaultPort,
        portRange,
      })
      suggestedPort = result.port
    } catch {
      // Fall back to default if no ports available
      suggestedPort = defaultPort
    }
  }

  const { port } = await inquirer.prompt<{ port: number }>([
    {
      type: 'input',
      name: 'port',
      message: 'Port:',
      default: String(suggestedPort),
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

  // Check for conflicts after selection
  const conflictContainer = containerPorts.get(port)
  if (conflictContainer) {
    console.log()
    console.log(
      chalk.yellow(
        `  ⚠ Warning: Port ${port} is already assigned to container "${conflictContainer}"`,
      ),
    )
    console.log(
      chalk.gray(
        '    Only one container can run on this port at a time.',
      ),
    )
    console.log()

    const { proceed } = await inquirer.prompt<{ proceed: string }>([
      {
        type: 'list',
        name: 'proceed',
        message: 'What would you like to do?',
        choices: [
          { name: `Use port ${port} anyway`, value: 'continue' },
          { name: 'Choose a different port', value: 'retry' },
        ],
      },
    ])

    if (proceed === 'retry') {
      return promptPort(defaultPort, engine)
    }
  } else {
    // Check if port is in use by something else
    const portAvailable = await portManager.isPortAvailable(port)
    if (!portAvailable) {
      console.log()
      console.log(
        chalk.yellow(`  ⚠ Warning: Port ${port} is currently in use`),
      )
      console.log(
        chalk.gray(
          '    The container will be created but may fail to start until the port is freed.',
        ),
      )
      console.log()

      const { proceed } = await inquirer.prompt<{ proceed: string }>([
        {
          type: 'list',
          name: 'proceed',
          message: 'What would you like to do?',
          choices: [
            { name: `Use port ${port} anyway`, value: 'continue' },
            { name: 'Choose a different port', value: 'retry' },
          ],
        },
      ])

      if (proceed === 'retry') {
        return promptPort(defaultPort, engine)
      }
    }
  }

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
 * @param containers - List of containers to choose from
 * @param message - Prompt message
 * @param options - Optional settings
 * @param options.includeBack - Include a back option (returns null when selected)
 */
export async function promptContainerSelect(
  containers: ContainerConfig[],
  message: string = 'Select container:',
  options: { includeBack?: boolean } = {},
): Promise<string | null> {
  if (containers.length === 0) {
    return null
  }

  type Choice = { name: string; value: string; short?: string }
  const choices: Choice[] = containers.map((c) => ({
    name: `${c.name} ${chalk.gray(`(${getEngineIcon(c.engine)} ${c.engine} ${c.version}, port ${c.port})`)} ${
      c.status === 'running'
        ? chalk.green('● running')
        : chalk.gray('○ stopped')
    }`,
    value: c.name,
    short: c.name,
  }))

  if (options.includeBack) {
    choices.push({ name: `${chalk.blue('←')} Back`, value: '__back__' })
  }

  const { container } = await inquirer.prompt<{ container: string }>([
    {
      type: 'list',
      name: 'container',
      message,
      choices,
    },
  ])

  if (container === '__back__') {
    return null
  }

  return container
}

/**
 * Sanitize a string to be a valid database name
 * Replaces invalid characters with underscores
 */
function sanitizeDatabaseName(name: string): string {
  // Replace invalid characters with underscores
  // Note: hyphens are excluded because they require quoting in SQL
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_')
  // Ensure it starts with a letter or underscore
  if (sanitized && !/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = '_' + sanitized
  }
  // Collapse multiple underscores
  sanitized = sanitized.replace(/_+/g, '_')
  // Trim trailing underscores
  sanitized = sanitized.replace(/_+$/, '')
  // Fallback if result is empty (e.g., input was "---")
  if (!sanitized) {
    sanitized = 'db'
  }
  return sanitized
}

/**
 * Prompt for database name
 * @param defaultName - Default value for the database name
 * @param engine - Database engine (mysql shows "schema" terminology)
 * @param options.allowBack - Allow empty input to go back (returns null)
 * @param options.existingDatabases - List of existing database names for context
 * @param options.disallowExisting - Validate that name is not in existingDatabases
 */
export function promptDatabaseName(
  defaultName?: string,
  engine?: string,
  options?: {
    allowBack?: false
    existingDatabases?: string[]
    disallowExisting?: boolean
  },
): Promise<string>
export function promptDatabaseName(
  defaultName: string | undefined,
  engine: string | undefined,
  options: {
    allowBack: true
    existingDatabases?: string[]
    disallowExisting?: boolean
  },
): Promise<string | null>
export async function promptDatabaseName(
  defaultName?: string,
  engine?: string,
  options?: {
    allowBack?: boolean
    existingDatabases?: string[]
    disallowExisting?: boolean
  },
): Promise<string | null> {
  // MySQL uses "schema" terminology (database and schema are synonymous)
  const baseLabel =
    engine === 'mysql' ? 'Database (schema) name' : 'Database name'

  // Sanitize the default name to ensure it's valid
  const sanitizedDefault = defaultName
    ? sanitizeDatabaseName(defaultName)
    : undefined

  // When allowBack is true, show the default in the message (since we can't use inquirer's default)
  const label =
    options?.allowBack && sanitizedDefault
      ? `${baseLabel} [${sanitizedDefault}]:`
      : `${baseLabel}:`

  const { database } = await inquirer.prompt<{ database: string }>([
    {
      type: 'input',
      name: 'database',
      message: label,
      default: options?.allowBack ? undefined : sanitizedDefault,
      validate: (input: string) => {
        if (options?.allowBack && !input) return true // Allow empty for back
        if (!input) return 'Database name is required'
        // PostgreSQL database naming rules (also valid for MySQL)
        // Hyphens excluded to avoid requiring quoted identifiers in SQL
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input)) {
          return 'Database name must start with a letter or underscore and contain only letters, numbers, and underscores'
        }
        if (input.length > 63) {
          return 'Database name must be 63 characters or less'
        }
        if (
          options?.disallowExisting &&
          options.existingDatabases?.includes(input)
        ) {
          return `Database "${input}" already exists. Choose a different name.`
        }
        return true
      },
    },
  ])

  if (options?.allowBack && !database) return null
  return database
}

/**
 * Prompt to select a database from a list of databases in a container
 * @param options.includeBack - Include a back option (returns null when selected)
 */
export function promptDatabaseSelect(
  databases: string[],
  message?: string,
  options?: { includeBack?: false },
): Promise<string>
export function promptDatabaseSelect(
  databases: string[],
  message: string | undefined,
  options: { includeBack: true },
): Promise<string | null>
export async function promptDatabaseSelect(
  databases: string[],
  message: string = 'Select database:',
  options?: { includeBack?: boolean },
): Promise<string | null> {
  if (databases.length === 0) {
    throw new Error('No databases available to select')
  }

  if (databases.length === 1 && !options?.includeBack) {
    return databases[0]
  }

  type Choice =
    | { name: string; value: string; short?: string }
    | inquirer.Separator

  const choices: Choice[] = databases.map((db, index) => ({
    name: index === 0 ? `${db} ${chalk.gray('(primary)')}` : db,
    value: db,
    short: db,
  }))

  if (options?.includeBack) {
    choices.push(new inquirer.Separator())
    choices.push({ name: `${chalk.blue('←')} Back`, value: BACK_VALUE })
  }

  const { database } = await inquirer.prompt<{ database: string }>([
    {
      type: 'list',
      name: 'database',
      message,
      choices,
    },
  ])

  if (database === BACK_VALUE) return null
  return database
}

/**
 * Prompt for backup format selection
 * Uses centralized format configuration from config/backup-formats.ts
 * @param options.includeBack - Include a back option (returns null when selected)
 */
export function promptBackupFormat(
  engine: string,
  options?: { includeBack?: false },
): Promise<'sql' | 'dump'>
export function promptBackupFormat(
  engine: string,
  options: { includeBack: true },
): Promise<'sql' | 'dump' | null>
export async function promptBackupFormat(
  engine: string,
  options?: { includeBack?: boolean },
): Promise<'sql' | 'dump' | null> {
  // Import here to avoid circular dependencies
  const {
    BACKUP_FORMATS,
    supportsFormatChoice,
    getDefaultFormat,
  } = await import('../../config/backup-formats')

  // If engine doesn't support format choice (e.g., Redis), return default
  if (!supportsFormatChoice(engine)) {
    return getDefaultFormat(engine)
  }

  const formats = BACKUP_FORMATS[engine] || BACKUP_FORMATS.postgresql

  type Choice =
    | { name: string; value: string; short?: string }
    | inquirer.Separator

  const choices: Choice[] = [
    {
      name: `${formats.sql.label} ${chalk.gray(`- ${formats.sql.description}`)}`,
      value: 'sql',
    },
    {
      name: `${formats.dump.label} ${chalk.gray(`- ${formats.dump.description}`)}`,
      value: 'dump',
    },
  ]

  if (options?.includeBack) {
    choices.push(new inquirer.Separator())
    choices.push({ name: `${chalk.blue('←')} Back`, value: BACK_VALUE })
  }

  const { format } = await inquirer.prompt<{ format: string }>([
    {
      type: 'list',
      name: 'format',
      message: 'Select backup format:',
      choices,
      default: formats.defaultFormat,
    },
  ])

  if (format === BACK_VALUE) return null
  return format as 'sql' | 'dump'
}

/**
 * Prompt for backup output directory
 * @returns Directory path or null if cancelled
 */
export async function promptBackupDirectory(): Promise<string | null> {
  const cwd = process.cwd()

  const { choice } = await inquirer.prompt<{ choice: string }>([
    {
      type: 'list',
      name: 'choice',
      message: 'Where to save the backup?',
      choices: [
        {
          name: `${chalk.cyan('.')} Current directory ${chalk.gray(`(${cwd})`)}`,
          value: 'cwd',
        },
        {
          name: `${chalk.yellow('...')} Choose different directory`,
          value: 'custom',
        },
        new inquirer.Separator(),
        { name: `${chalk.blue('←')} Back`, value: BACK_VALUE },
      ],
    },
  ])

  if (choice === BACK_VALUE) return null
  if (choice === 'cwd') return cwd

  const { customPath } = await inquirer.prompt<{ customPath: string }>([
    {
      type: 'input',
      name: 'customPath',
      message: 'Enter directory path:',
      default: cwd,
      validate: (input: string) => {
        if (!input.trim()) return 'Directory path is required'
        const resolved = resolve(input.replace(/^~/, process.env.HOME || ''))
        if (existsSync(resolved)) {
          if (!statSync(resolved).isDirectory()) {
            return 'Path is not a directory'
          }
        }
        // Directory will be created if it doesn't exist
        return true
      },
    },
  ])

  const { resolve } = await import('path')
  return resolve(customPath.replace(/^~/, process.env.HOME || ''))
}

/**
 * Prompt for backup filename
 * @param options.allowBack - Allow empty input to go back (returns null)
 */
export function promptBackupFilename(
  defaultName: string,
  options?: { allowBack?: false },
): Promise<string>
export function promptBackupFilename(
  defaultName: string,
  options: { allowBack: true },
): Promise<string | null>
export async function promptBackupFilename(
  defaultName: string,
  options?: { allowBack?: boolean },
): Promise<string | null> {
  // Show the default in the message when allowBack is true
  const message = options?.allowBack
    ? `Backup filename [${defaultName}]:`
    : 'Backup filename:'

  const { filename } = await inquirer.prompt<{ filename: string }>([
    {
      type: 'input',
      name: 'filename',
      message,
      default: options?.allowBack ? undefined : defaultName,
      validate: (input: string) => {
        if (options?.allowBack && !input) return true // Allow empty for back
        if (!input) return 'Filename is required'
        if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
          return 'Filename must contain only letters, numbers, underscores, and hyphens'
        }
        return true
      },
    },
  ])

  if (options?.allowBack && !filename) return null
  return filename
}

export type CreateOptions = {
  name: string
  engine: string
  version: string
  port: number
  database: string
  path?: string // SQLite file path
}

/**
 * Prompt for SQLite database file location
 * Similar to the relocate logic in container-handlers.ts
 */
export async function promptSqlitePath(
  containerName: string,
): Promise<string | undefined> {
  const defaultPath = `./${containerName}.sqlite`

  console.log(
    chalk.gray(
      '  SQLite databases are stored as files in your project directory.',
    ),
  )
  console.log(chalk.gray(`  Default: ${defaultPath}`))
  console.log()

  const { useDefault } = await inquirer.prompt<{ useDefault: string }>([
    {
      type: 'list',
      name: 'useDefault',
      message: 'Where should the database file be created?',
      choices: [
        { name: `Use default location (${defaultPath})`, value: 'default' },
        { name: 'Specify custom path', value: 'custom' },
      ],
    },
  ])

  if (useDefault === 'default') {
    return undefined // Use default
  }

  const { inputPath } = await inquirer.prompt<{ inputPath: string }>([
    {
      type: 'input',
      name: 'inputPath',
      message: 'File path:',
      default: defaultPath,
      validate: (input: string) => {
        if (!input) return 'Path is required'
        return true
      },
    },
  ])

  // Expand ~ to home directory
  let expandedPath = inputPath
  if (inputPath === '~') {
    expandedPath = homedir()
  } else if (inputPath.startsWith('~/')) {
    expandedPath = join(homedir(), inputPath.slice(2))
  }

  // Convert relative paths to absolute
  if (!expandedPath.startsWith('/')) {
    expandedPath = resolve(process.cwd(), expandedPath)
  }

  // Check if path looks like a file (has db extension) or directory
  const hasDbExtension = /\.(sqlite3?|db)$/i.test(expandedPath)

  // Treat as directory if:
  // - ends with /
  // - exists and is a directory
  // - doesn't have a database file extension (assume it's a directory path)
  const isDirectory =
    expandedPath.endsWith('/') ||
    (existsSync(expandedPath) && statSync(expandedPath).isDirectory()) ||
    !hasDbExtension

  let finalPath: string
  if (isDirectory) {
    // Remove trailing slash if present, then append filename
    const dirPath = expandedPath.endsWith('/')
      ? expandedPath.slice(0, -1)
      : expandedPath
    finalPath = join(dirPath, `${containerName}.sqlite`)
  } else {
    finalPath = expandedPath
  }

  // Check if file already exists
  if (existsSync(finalPath)) {
    console.log(chalk.yellow(`  Warning: File already exists: ${finalPath}`))
    const { overwrite } = await inquirer.prompt<{ overwrite: string }>([
      {
        type: 'list',
        name: 'overwrite',
        message:
          'A file already exists at this location. What would you like to do?',
        choices: [
          { name: 'Choose a different path', value: 'different' },
          { name: 'Cancel', value: 'cancel' },
        ],
      },
    ])

    if (overwrite === 'cancel') {
      throw new Error('Creation cancelled')
    }

    // Recursively prompt again
    return promptSqlitePath(containerName)
  }

  return finalPath
}

/**
 * Full interactive create flow
 */
export async function promptCreateOptions(): Promise<CreateOptions> {
  console.log(chalk.cyan('\n  ▣  Create New Database Container\n'))

  const engine = await promptEngine()
  const version = await promptVersion(engine)
  const name = await promptContainerName()
  const database = await promptDatabaseName(name, engine) // Default to container name

  // SQLite is file-based, no port needed but needs path
  let port = 0
  let path: string | undefined
  if (engine === 'sqlite') {
    path = await promptSqlitePath(name)
  } else {
    const engineDefaults = getEngineDefaults(engine)
    port = await promptPort(engineDefaults.defaultPort, engine)
  }

  return { name, engine, version, port, database, path }
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
          chalk.gray(
            `  Please install ${engineDeps.displayName} client tools:`,
          ),
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
    chalk.gray(
      `  Detected package manager: ${chalk.white(packageManager.name)}`,
    ),
  )
  console.log()

  // Get engine display name
  const engineDeps = getEngineDependencies(engine)
  const engineName = engineDeps?.displayName || engine

  // In CI environments (no TTY or CI env var), auto-install without prompting
  const isCI = !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    !process.stdin.isTTY
  )

  let shouldInstall = 'yes'

  if (!isCI) {
    const response = await inquirer.prompt<{ shouldInstall: string }>([
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
    shouldInstall = response.shouldInstall
  } else {
    console.log(
      chalk.gray(
        `  CI environment detected - auto-installing ${engineName} client tools...`,
      ),
    )
  }

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
      console.log(chalk.green(`  ${engineName} tools installed successfully!`))
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
  } catch (error) {
    const e = error as Error
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
