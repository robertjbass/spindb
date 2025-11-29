import { Command } from 'commander'
import chalk from 'chalk'
import { readdir, lstat, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import inquirer from 'inquirer'
import { paths } from '../../config/paths'
import { containerManager } from '../../core/container-manager'
import { promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { error, warning, info, formatBytes } from '../ui/theme'
import {
  getMysqldPath,
  getMysqlVersion,
  isMariaDB,
} from '../../engines/mysql/binary-detection'

const execAsync = promisify(exec)

/**
 * Installed engine info for PostgreSQL (downloaded binaries)
 */
type InstalledPostgresEngine = {
  engine: 'postgresql'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

/**
 * Installed engine info for MySQL (system-installed)
 */
type InstalledMysqlEngine = {
  engine: 'mysql'
  version: string
  path: string
  source: 'system'
  isMariaDB: boolean
}

type InstalledEngine = InstalledPostgresEngine | InstalledMysqlEngine

/**
 * Get the actual PostgreSQL version from the binary
 */
async function getPostgresVersion(binPath: string): Promise<string | null> {
  const postgresPath = join(binPath, 'bin', 'postgres')
  if (!existsSync(postgresPath)) {
    return null
  }

  try {
    const { stdout } = await execAsync(`"${postgresPath}" --version`)
    // Output: postgres (PostgreSQL) 17.7
    const match = stdout.match(/\(PostgreSQL\)\s+([\d.]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Get installed PostgreSQL engines from ~/.spindb/bin/
 */
async function getInstalledPostgresEngines(): Promise<
  InstalledPostgresEngine[]
> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledPostgresEngine[] = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Parse directory name: postgresql-17-darwin-arm64
      const match = entry.name.match(/^(\w+)-(.+)-(\w+)-(\w+)$/)
      if (match && match[1] === 'postgresql') {
        const [, , majorVersion, platform, arch] = match
        const dirPath = join(binDir, entry.name)

        // Get actual version from the binary
        const actualVersion =
          (await getPostgresVersion(dirPath)) || majorVersion

        // Get directory size
        let sizeBytes = 0
        try {
          const files = await readdir(dirPath, { recursive: true })
          for (const file of files) {
            try {
              const filePath = join(dirPath, file.toString())
              const fileStat = await lstat(filePath)
              if (fileStat.isFile()) {
                sizeBytes += fileStat.size
              }
            } catch {
              // Skip files we can't stat
            }
          }
        } catch {
          // Skip directories we can't read
        }

        engines.push({
          engine: 'postgresql',
          version: actualVersion,
          platform,
          arch,
          path: dirPath,
          sizeBytes,
          source: 'downloaded',
        })
      }
    }
  }

  // Sort by version descending
  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

/**
 * Detect system-installed MySQL
 */
async function getInstalledMysqlEngine(): Promise<InstalledMysqlEngine | null> {
  const mysqldPath = await getMysqldPath()
  if (!mysqldPath) {
    return null
  }

  const version = await getMysqlVersion(mysqldPath)
  if (!version) {
    return null
  }

  const mariadb = await isMariaDB()

  return {
    engine: 'mysql',
    version,
    path: mysqldPath,
    source: 'system',
    isMariaDB: mariadb,
  }
}

/**
 * Get all installed engines (PostgreSQL + MySQL)
 */
async function getInstalledEngines(): Promise<InstalledEngine[]> {
  const engines: InstalledEngine[] = []

  // Get PostgreSQL engines
  const pgEngines = await getInstalledPostgresEngines()
  engines.push(...pgEngines)

  // Get MySQL engine
  const mysqlEngine = await getInstalledMysqlEngine()
  if (mysqlEngine) {
    engines.push(mysqlEngine)
  }

  return engines
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((p) => parseInt(p, 10) || 0)
  const partsB = b.split('.').map((p) => parseInt(p, 10) || 0)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA !== numB) return numA - numB
  }
  return 0
}

/**
 * Engine icons
 */
const engineIcons: Record<string, string> = {
  postgresql: '🐘',
  mysql: '🐬',
}

/**
 * List subcommand action
 */
async function listEngines(options: { json?: boolean }): Promise<void> {
  const engines = await getInstalledEngines()

  if (options.json) {
    console.log(JSON.stringify(engines, null, 2))
    return
  }

  if (engines.length === 0) {
    console.log(info('No engines installed yet.'))
    console.log(
      chalk.gray(
        '  PostgreSQL engines are downloaded automatically when you create a container.',
      ),
    )
    console.log(
      chalk.gray(
        '  MySQL requires system installation (brew install mysql or apt install mysql-server).',
      ),
    )
    return
  }

  // Separate PostgreSQL and MySQL
  const pgEngines = engines.filter(
    (e): e is InstalledPostgresEngine => e.engine === 'postgresql',
  )
  const mysqlEngine = engines.find(
    (e): e is InstalledMysqlEngine => e.engine === 'mysql',
  )

  // Calculate total size for PostgreSQL
  const totalPgSize = pgEngines.reduce((acc, e) => acc + e.sizeBytes, 0)

  // Table header
  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.bold.white('ENGINE'.padEnd(14)) +
      chalk.bold.white('VERSION'.padEnd(12)) +
      chalk.bold.white('SOURCE'.padEnd(18)) +
      chalk.bold.white('SIZE'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(55)))

  // PostgreSQL rows
  for (const engine of pgEngines) {
    const icon = engineIcons[engine.engine] || '▣'
    const platformInfo = `${engine.platform}-${engine.arch}`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(`${icon} ${engine.engine}`.padEnd(13)) +
        chalk.yellow(engine.version.padEnd(12)) +
        chalk.gray(platformInfo.padEnd(18)) +
        chalk.white(formatBytes(engine.sizeBytes)),
    )
  }

  // MySQL row
  if (mysqlEngine) {
    const icon = engineIcons.mysql
    const displayName = mysqlEngine.isMariaDB ? 'mariadb' : 'mysql'

    console.log(
      chalk.gray('  ') +
        chalk.cyan(`${icon} ${displayName}`.padEnd(13)) +
        chalk.yellow(mysqlEngine.version.padEnd(12)) +
        chalk.gray('system'.padEnd(18)) +
        chalk.gray('(system-installed)'),
    )
  }

  console.log(chalk.gray('  ' + '─'.repeat(55)))

  // Summary
  console.log()
  if (pgEngines.length > 0) {
    console.log(
      chalk.gray(
        `  PostgreSQL: ${pgEngines.length} version(s), ${formatBytes(totalPgSize)}`,
      ),
    )
  }
  if (mysqlEngine) {
    console.log(chalk.gray(`  MySQL: system-installed at ${mysqlEngine.path}`))
  }
  console.log()
}

/**
 * Delete subcommand action
 */
async function deleteEngine(
  engine: string | undefined,
  version: string | undefined,
  options: { yes?: boolean },
): Promise<void> {
  // Get PostgreSQL engines only (MySQL can't be deleted via spindb)
  const pgEngines = await getInstalledPostgresEngines()

  if (pgEngines.length === 0) {
    console.log(warning('No deletable engines found.'))
    console.log(
      chalk.gray(
        '  MySQL is system-installed and cannot be deleted via spindb.',
      ),
    )
    return
  }

  let engineName = engine
  let engineVersion = version

  // Interactive selection if not provided
  if (!engineName || !engineVersion) {
    const choices = pgEngines.map((e) => ({
      name: `${engineIcons[e.engine]} ${e.engine} ${e.version} ${chalk.gray(`(${formatBytes(e.sizeBytes)})`)}`,
      value: `${e.engine}:${e.version}:${e.path}`,
    }))

    const { selected } = await inquirer.prompt<{ selected: string }>([
      {
        type: 'list',
        name: 'selected',
        message: 'Select engine to delete:',
        choices,
      },
    ])

    const [eng, ver] = selected.split(':')
    engineName = eng
    engineVersion = ver
  }

  // Find the engine
  const targetEngine = pgEngines.find(
    (e) => e.engine === engineName && e.version === engineVersion,
  )

  if (!targetEngine) {
    console.error(error(`Engine "${engineName} ${engineVersion}" not found`))
    process.exit(1)
  }

  // Check if any containers are using this engine version
  const containers = await containerManager.list()
  const usingContainers = containers.filter(
    (c) => c.engine === engineName && c.version === engineVersion,
  )

  if (usingContainers.length > 0) {
    console.error(
      error(
        `Cannot delete: ${usingContainers.length} container(s) are using ${engineName} ${engineVersion}`,
      ),
    )
    console.log(
      chalk.gray(
        `  Containers: ${usingContainers.map((c) => c.name).join(', ')}`,
      ),
    )
    console.log()
    console.log(chalk.gray('  Delete these containers first, then try again.'))
    process.exit(1)
  }

  // Confirm deletion
  if (!options.yes) {
    const confirmed = await promptConfirm(
      `Delete ${engineName} ${engineVersion}? This cannot be undone.`,
      false,
    )

    if (!confirmed) {
      console.log(warning('Deletion cancelled'))
      return
    }
  }

  // Delete the engine
  const spinner = createSpinner(`Deleting ${engineName} ${engineVersion}...`)
  spinner.start()

  try {
    await rm(targetEngine.path, { recursive: true, force: true })
    spinner.succeed(`Deleted ${engineName} ${engineVersion}`)
  } catch (err) {
    const e = err as Error
    spinner.fail(`Failed to delete: ${e.message}`)
    process.exit(1)
  }
}

// Main engines command
export const enginesCommand = new Command('engines')
  .description('Manage installed database engines')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      await listEngines(options)
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })

// Delete subcommand
enginesCommand
  .command('delete [engine] [version]')
  .description('Delete an installed engine version')
  .option('-y, --yes', 'Skip confirmation')
  .action(
    async (
      engine: string | undefined,
      version: string | undefined,
      options: { yes?: boolean },
    ) => {
      try {
        await deleteEngine(engine, version, options)
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
