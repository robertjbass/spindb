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
} from '../config/os-dependencies'
import { platformService } from './platform-service'
import { configManager } from './config-manager'

const execAsync = promisify(exec)

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

/**
 * Get the current platform
 */
export function getCurrentPlatform(): Platform {
  return platformService.getPlatformInfo().platform as Platform
}

export async function findBinary(
  binary: string,
): Promise<{ path: string; version?: string } | null> {
  try {
    // Use platformService to find the binary path
    const path = await platformService.findToolPath(binary)
    if (!path) return null

    // Try to get version
    const version = (await platformService.getToolVersion(path)) || undefined

    return { path, version }
  } catch {
    return null
  }
}

/**
 * Check the status of a single dependency
 */
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

/**
 * Check all dependencies for a specific engine
 */
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

/**
 * Check all dependencies across all engines
 */
export async function checkAllDependencies(): Promise<DependencyStatus[]> {
  const deps = getUniqueDependencies()
  const results = await Promise.all(deps.map((dep) => checkDependency(dep)))
  return results
}

/**
 * Get missing dependencies for an engine
 */
export async function getMissingDependencies(
  engine: string,
): Promise<Dependency[]> {
  const statuses = await checkEngineDependencies(engine)
  return statuses.filter((s) => !s.installed).map((s) => s.dependency)
}

/**
 * Get all missing dependencies across all engines
 */
export async function getAllMissingDependencies(): Promise<Dependency[]> {
  const statuses = await checkAllDependencies()
  return statuses.filter((s) => !s.installed).map((s) => s.dependency)
}

function hasTTY(): boolean {
  return process.stdin.isTTY === true
}

/**
 * Check if running as root
 */
function isRoot(): boolean {
  return process.getuid?.() === 0
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
  if (!hasTTY() && cmdToRun.includes('sudo')) {
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

/**
 * Build install command for a dependency using a package manager
 */
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

/**
 * Install a single dependency
 */
export async function installDependency(
  dependency: Dependency,
  packageManager: DetectedPackageManager,
): Promise<InstallResult> {
  try {
    const commands = buildInstallCommand(dependency, packageManager)

    for (const cmd of commands) {
      // Use inherited stdio so sudo can prompt for password in terminal
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

/**
 * Install all dependencies for an engine
 */
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

/**
 * Install all missing dependencies across all engines
 */
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
