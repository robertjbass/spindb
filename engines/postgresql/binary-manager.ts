import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import chalk from 'chalk'
import { createSpinner } from '../../cli/ui/spinner'
import { uiWarning, uiError, uiSuccess } from '../../cli/ui/theme'
import {
  detectPackageManager as detectPM,
  installEngineDependencies,
  getManualInstallInstructions,
  getCurrentPlatform,
} from '../../core/dependency-manager'
import { getEngineDependencies } from '../../config/os-dependencies'
import { getPostgresHomebrewPackage } from '../../config/engine-defaults'
import { logDebug } from '../../core/error-handler'
import { isWindows, platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import type { InstalledBinary } from '../../types'

const execAsync = promisify(exec)

export type BinaryInfo = {
  command: string
  version: string
  path: string
  packageManager?: string
  isCompatible: boolean
  requiredVersion?: string
}

export type PackageManager = {
  name: string
  checkCommand: string
  installCommand: (binary: string) => string
  updateCommand: (binary: string) => string
  versionCheckCommand: (binary: string) => string
}

// Detect which package manager is available on the system
export async function detectPackageManager(): Promise<PackageManager | null> {
  const pgPackage = getPostgresHomebrewPackage()
  const managers: PackageManager[] = [
    {
      name: 'brew',
      checkCommand: 'brew --version',
      installCommand: () =>
        `brew install ${pgPackage} && brew link --overwrite ${pgPackage}`,
      updateCommand: () =>
        `brew link --overwrite ${pgPackage} || brew install ${pgPackage} && brew link --overwrite ${pgPackage}`,
      versionCheckCommand: () =>
        `brew info ${pgPackage} | grep "${pgPackage}:" | head -1`,
    },
    {
      name: 'apt',
      checkCommand: 'apt --version',
      installCommand: () =>
        'sudo apt update && sudo apt install -y postgresql-client',
      updateCommand: () =>
        'sudo apt update && sudo apt upgrade -y postgresql-client',
      versionCheckCommand: () => 'apt show postgresql-client | grep Version',
    },
    {
      name: 'yum',
      checkCommand: 'yum --version',
      installCommand: () => 'sudo yum install -y postgresql',
      updateCommand: () => 'sudo yum update -y postgresql',
      versionCheckCommand: () => 'yum info postgresql | grep Version',
    },
    {
      name: 'dnf',
      checkCommand: 'dnf --version',
      installCommand: () => 'sudo dnf install -y postgresql',
      updateCommand: () => 'sudo dnf upgrade -y postgresql',
      versionCheckCommand: () => 'dnf info postgresql | grep Version',
    },
  ]

  for (const manager of managers) {
    try {
      await execAsync(manager.checkCommand)
      return manager
    } catch (error) {
      // Manager not available - log for debugging
      logDebug(`Package manager ${manager.name} not available`, {
        command: manager.checkCommand,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return null
}

// Get PostgreSQL version from pg_restore or psql
export async function getPostgresVersion(
  binary: 'pg_restore' | 'psql',
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`${binary} --version`)
    const match = stdout.match(/(\d+\.\d+)/)
    return match ? match[1] : null
  } catch (error) {
    logDebug(`Failed to get version for ${binary}`, {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// Find binary path using which/where command
export async function findBinaryPath(binary: string): Promise<string | null> {
  try {
    const command = isWindows() ? 'where' : 'which'
    const { stdout } = await execAsync(`${command} ${binary}`)
    return stdout.trim().split('\n')[0] || null
  } catch (error) {
    logDebug(`Binary ${binary} not found in PATH`, {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// Find binary path with fallback to refresh PATH cache
export async function findBinaryPathFresh(
  binary: string,
): Promise<string | null> {
  // Try normal lookup first
  const path = await findBinaryPath(binary)
  if (path) return path

  // Windows doesn't need shell refresh - PATH is always current
  if (isWindows()) {
    return null
  }

  // If not found on Unix, try to refresh PATH cache (especially after package updates)
  try {
    // Force shell to re-evaluate PATH
    const shell = process.env.SHELL || '/bin/bash'
    const shellConfig = shell.endsWith('zsh') ? '.zshrc' : '.bashrc'
    const { stdout } = await execWithTimeout(
      `${shell} -c 'source ~/${shellConfig} && which ${binary}'`,
    )
    return stdout.trim().split('\n')[0] || null
  } catch (error) {
    logDebug(`Binary ${binary} not found after PATH refresh`, {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// Execute command with timeout
async function execWithTimeout(
  command: string,
  timeoutMs: number = 60000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
      }
    }, timeoutMs)

    const child = exec(
      command,
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        if (error) {
          reject(error)
        } else {
          resolve({ stdout, stderr })
        }
      },
    )
  })
}

/**
 * Parse dump file to get required PostgreSQL version
 * Cross-platform: reads file header directly using Node.js
 */
export async function getDumpRequiredVersion(
  dumpPath: string,
): Promise<string | null> {
  try {
    // Read first 32 bytes of the file to check for PostgreSQL custom dump format
    // Custom dump magic: "PGDMP" followed by version info
    const { open } = await import('fs/promises')
    const fileHandle = await open(dumpPath, 'r')
    const buffer = Buffer.alloc(32)
    await fileHandle.read(buffer, 0, 32, 0)
    await fileHandle.close()

    // Check for PostgreSQL custom dump format magic bytes: "PGDMP"
    const header = buffer.toString('ascii', 0, 5)
    if (header === 'PGDMP') {
      // Bytes 5-6 contain version info in custom format
      // Byte 5: major version, Byte 6: minor version, Byte 7: revision
      const dumpMajor = buffer[5]
      const dumpMinor = buffer[6]

      logDebug(
        `Detected pg_dump custom format version: ${dumpMajor}.${dumpMinor}`,
      )

      // pg_dump version typically maps to PostgreSQL version
      // If it's a recent dump format, require a recent PostgreSQL
      if (dumpMajor >= 1 && dumpMinor >= 14) {
        return '15.0' // Modern dump format needs modern PostgreSQL
      }
    }

    // For plain SQL dumps or older formats, check if file looks like SQL
    const textHeader = buffer.toString('utf-8', 0, 20)
    if (textHeader.includes('--') || textHeader.includes('pg_dump')) {
      // Plain SQL dump - any PostgreSQL version should work
      return null
    }

    // Fallback: if we can't determine, assume it needs a recent version
    return '15.0'
  } catch (error) {
    logDebug(`Failed to determine dump version for ${dumpPath}`, {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// Check if a PostgreSQL version is compatible with a dump
export function isVersionCompatible(
  currentVersion: string,
  requiredVersion: string,
): boolean {
  const current = parseFloat(currentVersion)
  const required = parseFloat(requiredVersion)

  // PostgreSQL is forward-compatible: newer pg_restore can restore older dumps
  return current >= required
}

// Get binary information including version and compatibility
export async function getBinaryInfo(
  binary: 'pg_restore' | 'psql',
  dumpPath?: string,
): Promise<BinaryInfo | null> {
  const path = await findBinaryPath(binary)
  if (!path) {
    return null
  }

  const version = await getPostgresVersion(binary)
  if (!version) {
    return null
  }

  let requiredVersion: string | undefined
  let isCompatible = true

  if (dumpPath) {
    const dumpVersion = await getDumpRequiredVersion(dumpPath)
    requiredVersion = dumpVersion || undefined
    if (requiredVersion) {
      isCompatible = isVersionCompatible(version, requiredVersion)
    }
  }

  // Try to detect which package manager installed this binary
  let packageManager: string | undefined
  const { platform } = platformService.getPlatformInfo()
  try {
    if (platform === 'darwin') {
      // On macOS, check if it's from Homebrew
      const { stdout } = await execAsync(
        'brew list postgresql@* 2>/dev/null || brew list libpq 2>/dev/null || true',
      )
      if (stdout.includes('postgresql') || stdout.includes('libpq')) {
        packageManager = 'brew'
      }
    } else if (platform === 'linux') {
      // On Linux, check common package managers
      try {
        await execAsync('dpkg -S $(which pg_restore) 2>/dev/null')
        packageManager = 'apt'
      } catch {
        try {
          await execAsync('rpm -qf $(which pg_restore) 2>/dev/null')
          packageManager = 'yum/dnf'
        } catch {
          // Could be from source or other installation method
        }
      }
    }
    // On Windows (win32), we don't detect package managers - user installs via choco/scoop/winget
  } catch {
    // Could not determine package manager
  }

  return {
    command: binary,
    version,
    path,
    packageManager,
    isCompatible,
    requiredVersion,
  }
}

// Install PostgreSQL client tools using the new dependency manager
export async function installPostgresBinaries(): Promise<boolean> {
  const spinner = createSpinner('Checking package manager...')
  spinner.start()

  const packageManager = await detectPM()
  if (!packageManager) {
    spinner.fail('No supported package manager found')
    console.log(uiError('Please install PostgreSQL client tools manually:'))

    // Show platform-specific instructions from the registry
    const platform = getCurrentPlatform()
    const pgDeps = getEngineDependencies('postgresql')
    if (pgDeps && pgDeps.dependencies.length > 0) {
      const instructions = getManualInstallInstructions(
        pgDeps.dependencies[0],
        platform,
      )
      for (const instruction of instructions) {
        console.log(`  ${instruction}`)
      }
    }
    return false
  }

  spinner.succeed(`Found package manager: ${packageManager.name}`)

  // Don't use a spinner during installation - it blocks TTY access for sudo password prompts
  console.log(
    chalk.cyan(
      `  Installing PostgreSQL client tools with ${packageManager.name}...`,
    ),
  )
  console.log(chalk.gray('  You may be prompted for your password.'))
  console.log()

  try {
    const results = await installEngineDependencies(
      'postgresql',
      packageManager,
    )
    const allSuccess = results.every((r) => r.success)

    if (allSuccess) {
      console.log()
      console.log(uiSuccess('PostgreSQL client tools installed successfully'))
      return true
    } else {
      const failed = results.filter((r) => !r.success)
      console.log()
      console.log(uiError('Some installations failed:'))
      for (const f of failed) {
        console.log(uiError(`  ${f.dependency.name}: ${f.error}`))
      }
      return false
    }
  } catch (error: unknown) {
    console.log()
    console.log(uiError('Failed to install PostgreSQL client tools'))
    console.log(uiWarning('Please install manually'))
    if (error instanceof Error) {
      console.log(chalk.gray(`Error details: ${error.message}`))
    }
    return false
  }
}

// Update individual PostgreSQL client tools to resolve conflicts
export async function updatePostgresClientTools(): Promise<boolean> {
  const spinner = createSpinner('Updating PostgreSQL client tools...')
  spinner.start()

  const packageManager = await detectPackageManager()
  if (!packageManager) {
    spinner.fail('No supported package manager found')
    return false
  }

  spinner.succeed(`Found package manager: ${packageManager.name}`)

  const pgPackage = getPostgresHomebrewPackage()
  const latestMajor = pgPackage.split('@')[1] // e.g., '17' from 'postgresql@17'

  try {
    if (packageManager.name === 'brew') {
      // Handle brew conflicts and dependency issues
      // Unlink all older PostgreSQL versions before linking the latest
      const olderVersions = ['14', '15', '16'].filter((v) => v !== latestMajor)
      const unlinkCommands = olderVersions.map(
        (v) => `brew unlink postgresql@${v} 2>/dev/null || true`,
      )
      const commands = [
        ...unlinkCommands,
        `brew link --overwrite ${pgPackage}`, // Link latest version with overwrite
        'brew upgrade icu4c 2>/dev/null || true', // Fix ICU dependency issues
      ]

      for (const command of commands) {
        await execWithTimeout(command, 60000)
      }

      spinner.succeed('PostgreSQL client tools updated')
      console.log(
        uiSuccess(
          `Client tools successfully linked to PostgreSQL ${latestMajor}`,
        ),
      )
      console.log(chalk.gray('ICU dependencies have been updated'))
      return true
    } else {
      // For other package managers, use the standard update
      await execWithTimeout(packageManager.updateCommand('postgresql'), 120000)
      spinner.succeed('PostgreSQL client tools updated')
      console.log(uiSuccess('Update completed successfully'))
      return true
    }
  } catch (error: unknown) {
    spinner.fail('Update failed')
    console.log(uiError('Failed to update PostgreSQL client tools'))
    console.log(uiWarning('Please update manually:'))

    if (packageManager.name === 'brew') {
      const olderVersions = ['14', '15', '16'].filter((v) => v !== latestMajor)
      console.log(chalk.yellow('  macOS:'))
      console.log(
        chalk.yellow(
          `    brew unlink ${olderVersions.map((v) => `postgresql@${v}`).join(' ')}`,
        ),
      )
      console.log(chalk.yellow(`    brew link --overwrite ${pgPackage}`))
      console.log(
        chalk.yellow('    brew upgrade icu4c  # Fix ICU dependency issues'),
      )
      console.log(
        chalk.gray(
          '    This will update: pg_restore, pg_dump, psql, and fix dependency issues',
        ),
      )
    } else {
      console.log(`  ${packageManager.updateCommand('postgresql')}`)
    }

    if (error instanceof Error) {
      console.log(chalk.gray(`Error details: ${error.message}`))
    }
    return false
  }
}
export async function updatePostgresBinaries(): Promise<boolean> {
  const spinner = createSpinner('Checking package manager...')
  spinner.start()

  const packageManager = await detectPackageManager()
  if (!packageManager) {
    spinner.fail('No supported package manager found')
    return false
  }

  spinner.succeed(`Found package manager: ${packageManager.name}`)

  const updateSpinner = createSpinner(
    `Updating PostgreSQL client tools with ${packageManager.name}...`,
  )
  updateSpinner.start()

  try {
    await execWithTimeout(packageManager.updateCommand('postgresql'), 120000) // 2 minute timeout
    updateSpinner.succeed('PostgreSQL client tools updated')
    console.log(uiSuccess('Update completed successfully'))
    return true
  } catch (error: unknown) {
    updateSpinner.fail('Update failed')
    console.log(uiError('Failed to update PostgreSQL client tools'))
    console.log(uiWarning('Please update manually:'))
    console.log(`  ${packageManager.updateCommand('postgresql')}`)
    if (error instanceof Error) {
      console.log(chalk.gray(`Error details: ${error.message}`))
    }
    return false
  }
}

// Ensure PostgreSQL binary is available and compatible
export async function ensurePostgresBinary(
  binary: 'pg_restore' | 'psql',
  dumpPath?: string,
  options: { autoInstall?: boolean; autoUpdate?: boolean } = {},
): Promise<{ success: boolean; info: BinaryInfo | null; action?: string }> {
  const { autoInstall = true, autoUpdate = true } = options

  // Check if binary exists
  const info = await getBinaryInfo(binary, dumpPath)

  if (!info) {
    if (!autoInstall) {
      return { success: false, info: null, action: 'install_required' }
    }

    console.log(uiWarning(`${binary} not found on your system`))
    const success = await installPostgresBinaries()
    if (!success) {
      return { success: false, info: null, action: 'install_failed' }
    }

    // Check again after installation
    const newInfo = await getBinaryInfo(binary, dumpPath)
    if (!newInfo) {
      return { success: false, info: null, action: 'install_failed' }
    }

    return { success: true, info: newInfo, action: 'installed' }
  }

  // Check version compatibility
  if (dumpPath && !info.isCompatible) {
    if (!autoUpdate) {
      return { success: false, info, action: 'update_required' }
    }

    console.log(
      uiWarning(
        `Your ${binary} version (${info.version}) is incompatible with the dump file`,
      ),
    )
    if (info.requiredVersion) {
      console.log(
        uiWarning(`Required version: ${info.requiredVersion} or compatible`),
      )
    }

    const success = await updatePostgresBinaries()
    if (!success) {
      return { success: false, info, action: 'update_failed' }
    }

    // Check again after update
    const updatedInfo = await getBinaryInfo(binary, dumpPath)
    if (!updatedInfo || !updatedInfo.isCompatible) {
      return { success: false, info: updatedInfo, action: 'update_failed' }
    }

    return { success: true, info: updatedInfo, action: 'updated' }
  }

  return { success: true, info, action: 'compatible' }
}

/**
 * PostgreSQL Binary Manager class for consistency with other engines
 * Provides listInstalled() for offline fallback in hostdb-releases
 */
export class PostgreSQLBinaryManager {
  // List all installed PostgreSQL versions
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Match postgresql-{version}-{platform}-{arch} pattern
        const match = entry.name.match(/^postgresql-([\d.]+)-(\w+)-(\w+)$/)
        if (match) {
          installed.push({
            engine: 'postgresql' as InstalledBinary['engine'],
            version: match[1],
            platform: match[2],
            arch: match[3],
          })
        }
      }
    }

    return installed
  }
}

export const postgresqlBinaryManager = new PostgreSQLBinaryManager()
