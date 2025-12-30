/**
 * PostgreSQL Version Manager
 *
 * Manages multiple PostgreSQL versions installed on the system.
 * - macOS: Homebrew versioned installations (/opt/homebrew/opt/postgresql@17/bin)
 * - Linux: APT/YUM versioned installations (/usr/lib/postgresql/17/bin)
 *
 * Provides detection of installed versions and direct paths to versioned binaries.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { platformService } from './platform-service'
import { logDebug } from './error-handler'

const execAsync = promisify(exec)

// PostgreSQL versions supported by SpinDB
const SUPPORTED_PG_VERSIONS = ['14', '15', '16', '17']

export type InstalledPostgresVersion = {
  majorVersion: string // e.g., "14", "17"
  fullVersion: string // e.g., "14.20", "17.7.0"
  binPath: string // e.g., "/opt/homebrew/opt/postgresql@17/bin" or "/usr/lib/postgresql/17/bin"
  isLinked: boolean // Currently linked to system PATH (macOS only)
  source: 'homebrew' | 'apt' | 'system' | 'unknown'
}

export type VersionSwitchResult = {
  success: boolean
  previousVersion?: string
  currentVersion?: string
  error?: string
}

/**
 * Check if Homebrew is available on this system
 */
export async function isHomebrewAvailable(): Promise<boolean> {
  const { platform } = platformService.getPlatformInfo()
  if (platform !== 'darwin') return false

  try {
    await execAsync('brew --version')
    return true
  } catch {
    return false
  }
}

/**
 * Get the Homebrew prefix based on architecture
 */
function getHomebrewPrefix(): string {
  const { arch } = platformService.getPlatformInfo()
  return arch === 'arm64' ? '/opt/homebrew' : '/usr/local'
}

/**
 * Get Linux PostgreSQL bin paths (Debian/Ubuntu style)
 */
function getLinuxPostgresPath(majorVersion: string): string {
  return `/usr/lib/postgresql/${majorVersion}/bin`
}

/**
 * Get the currently linked PostgreSQL major version (if any)
 */
export async function getCurrentLinkedVersion(): Promise<string | null> {
  const prefix = getHomebrewPrefix()
  const pgDumpPath = `${prefix}/bin/pg_dump`

  if (!existsSync(pgDumpPath)) {
    return null
  }

  try {
    const { stdout } = await execAsync(`"${pgDumpPath}" --version`)
    const match = stdout.match(/(\d+)\.(\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Detect all PostgreSQL versions installed on the system
 * Works on both macOS (Homebrew) and Linux (APT/YUM)
 */
export async function detectInstalledPostgres(): Promise<
  InstalledPostgresVersion[]
> {
  const { platform } = platformService.getPlatformInfo()
  const installed: InstalledPostgresVersion[] = []

  // Get currently linked version (for macOS)
  const linkedVersion = await getCurrentLinkedVersion()

  if (platform === 'darwin') {
    // macOS: Check Homebrew installations
    const prefix = getHomebrewPrefix()

    for (const major of SUPPORTED_PG_VERSIONS) {
      const binPath = `${prefix}/opt/postgresql@${major}/bin`
      const pgDumpPath = `${binPath}/pg_dump`

      if (existsSync(pgDumpPath)) {
        try {
          const { stdout } = await execAsync(`"${pgDumpPath}" --version`)
          const match = stdout.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
          if (match) {
            installed.push({
              majorVersion: major,
              fullVersion: match[0],
              binPath,
              isLinked: linkedVersion === major,
              source: 'homebrew',
            })
          }
        } catch (error) {
          logDebug(`Could not get version for postgresql@${major}`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  } else if (platform === 'linux') {
    // Linux: Check /usr/lib/postgresql/*/bin (Debian/Ubuntu style)
    for (const major of SUPPORTED_PG_VERSIONS) {
      const binPath = getLinuxPostgresPath(major)
      const pgDumpPath = `${binPath}/pg_dump`

      if (existsSync(pgDumpPath)) {
        try {
          const { stdout } = await execAsync(`"${pgDumpPath}" --version`)
          const match = stdout.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
          if (match) {
            installed.push({
              majorVersion: major,
              fullVersion: match[0],
              binPath,
              isLinked: false, // Linux doesn't use linking like Homebrew
              source: 'apt',
            })
          }
        } catch (error) {
          logDebug(`Could not get version for postgresql-${major}`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  return installed
}

/**
 * Get the direct path to a PostgreSQL binary for a specific major version
 * This allows using a specific version without changing system links
 *
 * Works on:
 * - macOS: /opt/homebrew/opt/postgresql@17/bin/pg_dump
 * - Linux: /usr/lib/postgresql/17/bin/pg_dump
 */
export async function getDirectBinaryPath(
  tool: 'pg_dump' | 'pg_restore' | 'psql' | 'pg_basebackup',
  majorVersion: string,
): Promise<string | null> {
  const { platform } = platformService.getPlatformInfo()

  if (platform === 'darwin') {
    // macOS: Homebrew path
    const prefix = getHomebrewPrefix()
    const path = `${prefix}/opt/postgresql@${majorVersion}/bin/${tool}`
    if (existsSync(path)) return path
  } else if (platform === 'linux') {
    // Linux: Debian/Ubuntu path
    const path = `${getLinuxPostgresPath(majorVersion)}/${tool}`
    if (existsSync(path)) return path
  }

  return null
}

/**
 * Find a compatible PostgreSQL version for the target major version
 * Returns the best available version that is >= targetMajor
 */
export async function findCompatibleVersion(
  targetMajor: number,
): Promise<InstalledPostgresVersion | null> {
  const installed = await detectInstalledPostgres()

  // Filter versions >= target
  const compatible = installed.filter(
    (v) => parseInt(v.majorVersion, 10) >= targetMajor,
  )

  if (compatible.length === 0) {
    return null
  }

  // Prefer the currently linked version if it's compatible
  const linked = compatible.find((v) => v.isLinked)
  if (linked) {
    return linked
  }

  // Otherwise return the lowest compatible version (closest to target)
  compatible.sort(
    (a, b) => parseInt(a.majorVersion, 10) - parseInt(b.majorVersion, 10),
  )
  return compatible[0]
}

/**
 * Switch system to use a specific PostgreSQL version
 *
 * - macOS: Uses `brew link` to change symlinks
 * - Linux: Uses `update-alternatives` if available (Debian/Ubuntu)
 *
 * NOTE: Prefer getDirectBinaryPath() when possible to avoid side effects
 */
export async function switchHomebrewVersion(
  targetMajor: string,
): Promise<VersionSwitchResult> {
  const { platform } = platformService.getPlatformInfo()

  if (platform === 'darwin') {
    return switchHomebrewVersionMacOS(targetMajor)
  } else if (platform === 'linux') {
    return switchVersionLinux(targetMajor)
  }

  return {
    success: false,
    error: 'Version switching not supported on this platform',
  }
}

/**
 * Switch PostgreSQL version on macOS using Homebrew
 */
async function switchHomebrewVersionMacOS(
  targetMajor: string,
): Promise<VersionSwitchResult> {
  if (!(await isHomebrewAvailable())) {
    return { success: false, error: 'Homebrew not available' }
  }

  const installed = await detectInstalledPostgres()
  const target = installed.find((v) => v.majorVersion === targetMajor)

  if (!target) {
    return {
      success: false,
      error: `PostgreSQL ${targetMajor} is not installed via Homebrew. Install with: brew install postgresql@${targetMajor}`,
    }
  }

  if (target.isLinked) {
    return {
      success: true,
      currentVersion: targetMajor,
      previousVersion: targetMajor,
    }
  }

  const previousLinked = installed.find((v) => v.isLinked)

  try {
    // Unlink all versions first
    for (const ver of installed) {
      await execAsync(
        `brew unlink postgresql@${ver.majorVersion} 2>/dev/null || true`,
      )
    }

    // Link target version
    await execAsync(`brew link --overwrite postgresql@${targetMajor}`)

    logDebug('Switched Homebrew PostgreSQL version', {
      from: previousLinked?.majorVersion,
      to: targetMajor,
    })

    return {
      success: true,
      previousVersion: previousLinked?.majorVersion,
      currentVersion: targetMajor,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * "Switch" PostgreSQL version on Linux (no-op verification only)
 *
 * Unlike macOS where Homebrew uses symlinks that need switching, Linux installs
 * PostgreSQL versions side-by-side in versioned paths (e.g., /usr/lib/postgresql/17/bin).
 * We access these directly via getDirectBinaryPath(), so no symlink switching is needed.
 * This function just verifies the target version is installed.
 */
async function switchVersionLinux(
  targetMajor: string,
): Promise<VersionSwitchResult> {
  const installed = await detectInstalledPostgres()
  const target = installed.find((v) => v.majorVersion === targetMajor)

  if (!target) {
    return {
      success: false,
      error: `PostgreSQL ${targetMajor} is not installed. Install with: sudo apt install postgresql-client-${targetMajor}`,
    }
  }

  // No action required - Linux uses versioned paths directly, no symlink switching needed
  logDebug(
    'Linux: Version verified, no switching required (using direct path)',
    {
      version: targetMajor,
      binPath: target.binPath,
    },
  )

  return {
    success: true,
    currentVersion: targetMajor,
  }
}

// Get all client tools for a specific PostgreSQL version
export async function getVersionedToolPaths(majorVersion: string): Promise<{
  pgDump: string | null
  pgRestore: string | null
  psql: string | null
  pgBasebackup: string | null
}> {
  return {
    pgDump: await getDirectBinaryPath('pg_dump', majorVersion),
    pgRestore: await getDirectBinaryPath('pg_restore', majorVersion),
    psql: await getDirectBinaryPath('psql', majorVersion),
    pgBasebackup: await getDirectBinaryPath('pg_basebackup', majorVersion),
  }
}
