import { exec } from 'child_process'
import { promisify } from 'util'
import chalk from 'chalk'
import { createSpinner } from '../cli/ui/spinner'
import { warning, error as themeError, success } from '../cli/ui/theme'

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

/**
 * Detect which package manager is available on the system
 */
export async function detectPackageManager(): Promise<PackageManager | null> {
  const managers: PackageManager[] = [
    {
      name: 'brew',
      checkCommand: 'brew --version',
      installCommand: () =>
        'brew install postgresql@17 && brew link --overwrite postgresql@17',
      updateCommand: () =>
        'brew link --overwrite postgresql@17 || brew install postgresql@17 && brew link --overwrite postgresql@17',
      versionCheckCommand: () =>
        'brew info postgresql@17 | grep "postgresql@17:" | head -1',
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
    } catch {
      // Manager not available
    }
  }

  return null
}

/**
 * Get PostgreSQL version from pg_restore or psql
 */
export async function getPostgresVersion(
  binary: 'pg_restore' | 'psql',
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`${binary} --version`)
    const match = stdout.match(/(\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Find binary path using which/where command
 */
export async function findBinaryPath(binary: string): Promise<string | null> {
  try {
    const command = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execAsync(`${command} ${binary}`)
    return stdout.trim().split('\n')[0] || null
  } catch {
    return null
  }
}

/**
 * Find binary path with fallback to refresh PATH cache
 */
export async function findBinaryPathFresh(
  binary: string,
): Promise<string | null> {
  // Try normal lookup first
  const path = await findBinaryPath(binary)
  if (path) return path

  // If not found, try to refresh PATH cache (especially after package updates)
  try {
    // Force shell to re-evaluate PATH
    const shell = process.env.SHELL || '/bin/bash'
    const { stdout } = await execWithTimeout(
      `${shell} -c 'source ~/.${shell.endsWith('zsh') ? 'zshrc' : 'bashrc'} && which ${binary}'`,
    )
    return stdout.trim().split('\n')[0] || null
  } catch {
    return null
  }
}

/**
 * Execute command with timeout
 */
async function execWithTimeout(
  command: string,
  timeoutMs: number = 60000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = exec(
      command,
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
        } else {
          resolve({ stdout, stderr })
        }
      },
    )

    // Additional timeout safety
    setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)
  })
}

/**
 * Parse dump file to get required PostgreSQL version
 */
export async function getDumpRequiredVersion(
  dumpPath: string,
): Promise<string | null> {
  try {
    // Try to read pg_dump custom format header
    const { stdout } = await execAsync(`file "${dumpPath}"`)
    if (stdout.includes('PostgreSQL custom database dump')) {
      // For custom format, we need to check the version in the dump
      try {
        const { stdout: hexdump } = await execAsync(
          `hexdump -C "${dumpPath}" | head -5`,
        )
        // Look for version info in the header (simplified approach)
        const versionMatch = hexdump.match(/(\d+)\.(\d+)/)
        if (versionMatch) {
          // If it's a recent dump, assume it needs the latest PostgreSQL
          const majorVersion = parseInt(versionMatch[1])
          if (majorVersion >= 15) {
            return '15.0' // Minimum version for recent dumps
          }
        }
      } catch {
        // If hexdump fails, fall back to checking error patterns
      }
    }

    // Fallback: if we can't determine, assume it needs a recent version
    return '15.0'
  } catch {
    return null
  }
}

/**
 * Check if a PostgreSQL version is compatible with a dump
 */
export function isVersionCompatible(
  currentVersion: string,
  requiredVersion: string,
): boolean {
  const current = parseFloat(currentVersion)
  const required = parseFloat(requiredVersion)

  // Current version should be >= required version
  // But not too far ahead (major version compatibility)
  return current >= required && Math.floor(current) === Math.floor(required)
}

/**
 * Get binary information including version and compatibility
 */
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
  try {
    if (process.platform === 'darwin') {
      // On macOS, check if it's from Homebrew
      const { stdout } = await execAsync(
        'brew list postgresql@* 2>/dev/null || brew list libpq 2>/dev/null || true',
      )
      if (stdout.includes('postgresql') || stdout.includes('libpq')) {
        packageManager = 'brew'
      }
    } else {
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

/**
 * Install PostgreSQL client tools
 */
export async function installPostgresBinaries(): Promise<boolean> {
  const spinner = createSpinner('Checking package manager...')
  spinner.start()

  const packageManager = await detectPackageManager()
  if (!packageManager) {
    spinner.fail('No supported package manager found')
    console.log(themeError('Please install PostgreSQL client tools manually:'))
    console.log('  macOS: brew install libpq')
    console.log('  Ubuntu/Debian: sudo apt install postgresql-client')
    console.log('  CentOS/RHEL/Fedora: sudo yum install postgresql')
    return false
  }

  spinner.succeed(`Found package manager: ${packageManager.name}`)

  const installSpinner = createSpinner(
    `Installing PostgreSQL client tools with ${packageManager.name}...`,
  )
  installSpinner.start()

  try {
    await execWithTimeout(packageManager.installCommand('postgresql'), 120000) // 2 minute timeout
    installSpinner.succeed('PostgreSQL client tools installed')
    console.log(success('Installation completed successfully'))
    return true
  } catch (error: unknown) {
    installSpinner.fail('Installation failed')
    console.log(themeError('Failed to install PostgreSQL client tools'))
    console.log(warning('Please install manually:'))
    console.log(`  ${packageManager.installCommand('postgresql')}`)
    if (error instanceof Error) {
      console.log(chalk.gray(`Error details: ${error.message}`))
    }
    return false
  }
}

/**
 * Update individual PostgreSQL client tools to resolve conflicts
 */
export async function updatePostgresClientTools(): Promise<boolean> {
  const spinner = createSpinner('Updating PostgreSQL client tools...')
  spinner.start()

  const packageManager = await detectPackageManager()
  if (!packageManager) {
    spinner.fail('No supported package manager found')
    return false
  }

  spinner.succeed(`Found package manager: ${packageManager.name}`)

  try {
    if (packageManager.name === 'brew') {
      // Handle brew conflicts and dependency issues
      const commands = [
        'brew unlink postgresql@14 2>/dev/null || true', // Unlink old version if exists
        'brew unlink postgresql@15 2>/dev/null || true', // Unlink other old versions
        'brew unlink postgresql@16 2>/dev/null || true',
        'brew link --overwrite postgresql@17', // Link postgresql@17 with overwrite
        'brew upgrade icu4c 2>/dev/null || true', // Fix ICU dependency issues
      ]

      for (const command of commands) {
        await execWithTimeout(command, 60000)
      }

      spinner.succeed('PostgreSQL client tools updated')
      console.log(success('Client tools successfully linked to PostgreSQL 17'))
      console.log(chalk.gray('ICU dependencies have been updated'))
      return true
    } else {
      // For other package managers, use the standard update
      await execWithTimeout(packageManager.updateCommand('postgresql'), 120000)
      spinner.succeed('PostgreSQL client tools updated')
      console.log(success('Update completed successfully'))
      return true
    }
  } catch (error: unknown) {
    spinner.fail('Update failed')
    console.log(themeError('Failed to update PostgreSQL client tools'))
    console.log(warning('Please update manually:'))

    if (packageManager.name === 'brew') {
      console.log(chalk.yellow('  macOS:'))
      console.log(
        chalk.yellow(
          '    brew unlink postgresql@14 postgresql@15 postgresql@16',
        ),
      )
      console.log(chalk.yellow('    brew link --overwrite postgresql@17'))
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
    console.log(success('Update completed successfully'))
    return true
  } catch (error: unknown) {
    updateSpinner.fail('Update failed')
    console.log(themeError('Failed to update PostgreSQL client tools'))
    console.log(warning('Please update manually:'))
    console.log(`  ${packageManager.updateCommand('postgresql')}`)
    if (error instanceof Error) {
      console.log(chalk.gray(`Error details: ${error.message}`))
    }
    return false
  }
}

/**
 * Ensure PostgreSQL binary is available and compatible
 */
export async function ensurePostgresBinary(
  binary: 'pg_restore' | 'psql',
  dumpPath?: string,
  options: { autoInstall?: boolean; autoUpdate?: boolean } = {},
): Promise<{ success: boolean; info: BinaryInfo | null; action?: string }> {
  const { autoInstall = true, autoUpdate = true } = options

  console.log(
    `[DEBUG] ensurePostgresBinary called for ${binary}, dumpPath: ${dumpPath}`,
  )

  // Check if binary exists
  const info = await getBinaryInfo(binary, dumpPath)

  console.log(`[DEBUG] getBinaryInfo result:`, info)

  if (!info) {
    if (!autoInstall) {
      return { success: false, info: null, action: 'install_required' }
    }

    console.log(warning(`${binary} not found on your system`))
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
    console.log(
      `[DEBUG] Version incompatible: current=${info.version}, required=${info.requiredVersion}`,
    )

    if (!autoUpdate) {
      return { success: false, info, action: 'update_required' }
    }

    console.log(
      warning(
        `Your ${binary} version (${info.version}) is incompatible with the dump file`,
      ),
    )
    if (info.requiredVersion) {
      console.log(
        warning(`Required version: ${info.requiredVersion} or compatible`),
      )
    }

    const success = await updatePostgresBinaries()
    if (!success) {
      return { success: false, info, action: 'update_failed' }
    }

    // Check again after update
    const updatedInfo = await getBinaryInfo(binary, dumpPath)
    if (!updatedInfo || !updatedInfo.isCompatible) {
      console.log(`[DEBUG] Update failed or still incompatible:`, updatedInfo)
      return { success: false, info: updatedInfo, action: 'update_failed' }
    }

    return { success: true, info: updatedInfo, action: 'updated' }
  }

  console.log(`[DEBUG] Binary is compatible, returning success`)
  return { success: true, info, action: 'compatible' }
}
