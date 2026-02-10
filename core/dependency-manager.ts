/**
 * Dependency Manager
 *
 * Handles checking, installing, and updating OS-level dependencies
 * for database engines.
 */

import { exec, spawnSync } from 'child_process'
import { promisify } from 'util'
import {
  type PackageManagerId,
  type PackageManagerConfig,
  type Dependency,
  type Platform,
  packageManagers,
  getEngineDependencies,
  getUniqueDependencies,
  usqlDependency,
  pgcliDependency,
  mycliDependency,
  litecliDependency,
  iredisDependency,
} from '../config/os-dependencies'
import { platformService } from './platform-service'
import { configManager } from './config-manager'
import type { BinaryTool } from '../types'

const execAsync = promisify(exec)

const KNOWN_BINARY_TOOLS: readonly BinaryTool[] = [
  // PostgreSQL
  'postgres',
  'pg_ctl',
  'initdb',
  'psql',
  'pg_dump',
  'pg_restore',
  'pg_basebackup',
  // MySQL
  'mysql',
  'mysqldump',
  'mysqlpump',
  'mysqld',
  'mysqladmin',
  // MariaDB
  'mariadb',
  'mariadb-dump',
  'mariadbd',
  'mariadb-admin',
  // SQLite
  'sqlite3',
  'sqldiff',
  'sqlite3_analyzer',
  'sqlite3_rsync',
  // DuckDB
  'duckdb',
  // MongoDB
  'mongod',
  'mongosh',
  'mongodump',
  'mongorestore',
  // FerretDB
  'ferretdb',
  // Redis
  'redis-server',
  'redis-cli',
  // Valkey
  'valkey-server',
  'valkey-cli',
  // ClickHouse
  'clickhouse',
  // Qdrant
  'qdrant',
  // Meilisearch
  'meilisearch',
  // CouchDB
  'couchdb',
  // CockroachDB
  'cockroach',
  // SurrealDB
  'surreal',
  // QuestDB
  'questdb',
  // TypeDB
  'typedb',
  'typedb_console_bin',
  // InfluxDB
  'influxdb3',
  // Enhanced shells (optional)
  'pgcli',
  'mycli',
  'litecli',
  'iredis',
  'usql',
] as const

export type DependencyStatus = {
  dependency: Dependency
  installed: boolean
  path?: string
  version?: string
}

export type DetectedPackageManager = {
  config: PackageManagerConfig
  id: PackageManagerId
  name: string
}

export type InstallResult = {
  success: boolean
  dependency: Dependency
  error?: string
}

function isBinaryTool(binary: string): binary is BinaryTool {
  return KNOWN_BINARY_TOOLS.includes(binary as BinaryTool)
}

export async function detectPackageManager(): Promise<DetectedPackageManager | null> {
  const { platform } = platformService.getPlatformInfo()

  // Filter to package managers available on this platform
  const candidates = packageManagers.filter((pm) =>
    pm.platforms.includes(platform),
  )

  for (const pm of candidates) {
    try {
      await execAsync(pm.checkCommand)
      return {
        config: pm,
        id: pm.id,
        name: pm.name,
      }
    } catch {
      // Package manager not available
    }
  }

  return null
}

export function getCurrentPlatform(): Platform {
  return platformService.getPlatformInfo().platform as Platform
}

export async function findBinary(
  binary: string,
): Promise<{ path: string; version?: string } | null> {
  try {
    // First check if we have this binary registered in config (e.g., from downloaded PostgreSQL)
    if (isBinaryTool(binary)) {
      const configPath = await configManager.getBinaryPath(binary)
      if (configPath) {
        const version =
          (await platformService.getToolVersion(configPath)) || undefined
        return { path: configPath, version }
      }
    }

    // Fall back to system PATH search
    const path = await platformService.findToolPath(binary)
    if (!path) return null

    // Try to get version
    const version = (await platformService.getToolVersion(path)) || undefined

    return { path, version }
  } catch {
    return null
  }
}

export async function checkDependency(
  dependency: Dependency,
): Promise<DependencyStatus> {
  const result = await findBinary(dependency.binary)

  return {
    dependency,
    installed: result !== null,
    path: result?.path,
    version: result?.version,
  }
}

export async function checkEngineDependencies(
  engine: string,
): Promise<DependencyStatus[]> {
  const engineDeps = getEngineDependencies(engine)
  if (!engineDeps) return []

  const results = await Promise.all(
    engineDeps.dependencies.map((dep) => checkDependency(dep)),
  )

  return results
}

export async function checkAllDependencies(): Promise<DependencyStatus[]> {
  const deps = getUniqueDependencies()
  const results = await Promise.all(deps.map((dep) => checkDependency(dep)))
  return results
}

export async function getMissingDependencies(
  engine: string,
): Promise<Dependency[]> {
  const statuses = await checkEngineDependencies(engine)
  return statuses.filter((s) => !s.installed).map((s) => s.dependency)
}

export async function getAllMissingDependencies(): Promise<Dependency[]> {
  const statuses = await checkAllDependencies()
  return statuses.filter((s) => !s.installed).map((s) => s.dependency)
}

function hasTTY(): boolean {
  return process.stdin.isTTY === true
}

function isRoot(): boolean {
  return process.getuid?.() === 0
}

// Check if running in a CI environment where sudo doesn't require a password
function isPasswordlessSudoEnvironment(): boolean {
  // GitHub Actions, GitLab CI, CircleCI, Travis CI, etc.
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS
  )
}

/**
 * Execute command with inherited stdio (for TTY support with sudo)
 * Uses spawnSync to properly connect to the terminal for password prompts
 */
function execWithInheritedStdio(command: string): void {
  let cmdToRun = command

  // If already running as root, strip sudo from the command
  if (isRoot() && command.startsWith('sudo ')) {
    cmdToRun = command.replace(/^sudo\s+/, '')
  }

  // Check if we need a TTY for sudo password prompts
  // Skip this check in CI environments where sudo doesn't require a password
  if (
    !hasTTY() &&
    cmdToRun.includes('sudo') &&
    !isPasswordlessSudoEnvironment()
  ) {
    throw new Error(
      'Cannot run sudo commands without an interactive terminal. Please run the install command manually:\n' +
        `  ${command}`,
    )
  }

  const result = spawnSync(cmdToRun, [], {
    shell: true,
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(
      `Command failed with exit code ${result.status}: ${cmdToRun}`,
    )
  }
}

export function buildInstallCommand(
  dependency: Dependency,
  packageManager: DetectedPackageManager,
): string[] {
  const pkgDef = dependency.packages[packageManager.id]
  if (!pkgDef) {
    throw new Error(
      `No package definition for ${dependency.name} with ${packageManager.name}`,
    )
  }

  const commands: string[] = []

  // Pre-install commands
  if (pkgDef.preInstall) {
    commands.push(...pkgDef.preInstall)
  }

  // Main install command
  const installCmd = packageManager.config.installTemplate.replace(
    '{package}',
    pkgDef.package,
  )
  commands.push(installCmd)

  // Post-install commands
  if (pkgDef.postInstall) {
    commands.push(...pkgDef.postInstall)
  }

  return commands
}

export async function installDependency(
  dependency: Dependency,
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  try {
    const commands = buildInstallCommand(dependency, packageManager)

    for (const cmd of commands) {
      // Use inherited stdio so sudo can prompt for password in terminal
      // Note: execWithInheritedStdio handles sudo stripping when running as root
      execWithInheritedStdio(cmd)
    }

    // Refresh config cache after package manager interaction
    // This ensures newly installed tools are detected with correct versions
    await configManager.refreshAllBinaries()

    // Verify installation
    const status = await checkDependency(dependency)
    if (!status.installed) {
      return {
        success: false,
        dependency,
        error: 'Installation completed but binary not found in PATH',
      }
    }

    return { success: true, dependency }
  } catch (error) {
    return {
      success: false,
      dependency,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function installEngineDependencies(
  engine: string,
  packageManager: DetectedPackageManager,
): Promise<InstallResult[]> {
  const missing = await getMissingDependencies(engine)
  if (missing.length === 0) return []

  // Group by package to avoid reinstalling the same package multiple times
  const packageGroups = new Map<string, Dependency[]>()
  for (const dep of missing) {
    const pkgDef = dep.packages[packageManager.id]
    if (pkgDef) {
      const existing = packageGroups.get(pkgDef.package) || []
      existing.push(dep)
      packageGroups.set(pkgDef.package, existing)
    }
  }

  const results: InstallResult[] = []

  // Install each unique package once
  for (const [, deps] of packageGroups) {
    // Install using the first dependency (they all use the same package)
    const result = await installDependency(deps[0], packageManager)

    // Mark all dependencies from this package with the same result
    for (const dep of deps) {
      results.push({ ...result, dependency: dep })
    }
  }

  return results
}

// Install all missing dependencies across all engines
export async function installAllDependencies(
  packageManager: DetectedPackageManager,
): Promise<InstallResult[]> {
  const missing = await getAllMissingDependencies()
  if (missing.length === 0) return []

  // Group by package
  const packageGroups = new Map<string, Dependency[]>()
  for (const dep of missing) {
    const pkgDef = dep.packages[packageManager.id]
    if (pkgDef) {
      const existing = packageGroups.get(pkgDef.package) || []
      existing.push(dep)
      packageGroups.set(pkgDef.package, existing)
    }
  }

  const results: InstallResult[] = []

  for (const [, deps] of packageGroups) {
    const result = await installDependency(deps[0], packageManager)
    for (const dep of deps) {
      results.push({ ...result, dependency: dep })
    }
  }

  return results
}

export function getManualInstallInstructions(
  dependency: Dependency,
  platform: Platform = getCurrentPlatform(),
): string[] {
  return dependency.manualInstall[platform] || []
}

export async function isUsqlInstalled(): Promise<boolean> {
  const status = await checkDependency(usqlDependency)
  return status.installed
}

export async function installUsql(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(usqlDependency, packageManager)
}

export function getUsqlManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(usqlDependency, platform)
}

export async function isPgcliInstalled(): Promise<boolean> {
  const status = await checkDependency(pgcliDependency)
  return status.installed
}

export async function installPgcli(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(pgcliDependency, packageManager)
}

export function getPgcliManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(pgcliDependency, platform)
}

export async function isMycliInstalled(): Promise<boolean> {
  const status = await checkDependency(mycliDependency)
  return status.installed
}

export async function installMycli(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(mycliDependency, packageManager)
}

export function getMycliManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(mycliDependency, platform)
}

export async function isLitecliInstalled(): Promise<boolean> {
  const status = await checkDependency(litecliDependency)
  return status.installed
}

export async function installLitecli(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(litecliDependency, packageManager)
}

export function getLitecliManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(litecliDependency, platform)
}

export async function isIredisInstalled(): Promise<boolean> {
  const status = await checkDependency(iredisDependency)
  return status.installed
}

export async function installIredis(
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  return installDependency(iredisDependency, packageManager)
}

export function getIredisManualInstructions(
  platform: Platform = getCurrentPlatform(),
): string[] {
  return getManualInstallInstructions(iredisDependency, platform)
}
