import { join } from 'path'
import { readdirSync, existsSync } from 'fs'
import { getEngineDefaults } from './engine-defaults'
import { platformService } from '../core/platform-service'

/**
 * Get the SpinDB home directory.
 * Checks SPINDB_HOME env var first (useful for testing), then falls back
 * to platform-specific home directory detection.
 */
function getSpinDBHome(): string {
  if (process.env.SPINDB_HOME) {
    return process.env.SPINDB_HOME
  }
  const platformInfo = platformService.getPlatformInfo()
  return join(platformInfo.homeDir, '.spindb')
}

const SPINDB_HOME = getSpinDBHome()

// Options for container path functions
type ContainerPathOptions = {
  engine: string
}

// Options for binary path functions
type BinaryPathOptions = {
  engine: string
  version: string
  platform: string
  arch: string
}

export const paths = {
  // Root directory for all spindb data
  root: SPINDB_HOME,

  // Directory for downloaded database binaries
  bin: join(SPINDB_HOME, 'bin'),

  // Directory for container data
  containers: join(SPINDB_HOME, 'containers'),

  // Global config file
  config: join(SPINDB_HOME, 'config.json'),

  // Directory for rename backup files
  renameBackups: join(SPINDB_HOME, 'backups', 'rename'),

  // Get path for a specific binary version
  getBinaryPath(options: BinaryPathOptions): string {
    const { engine, version, platform, arch } = options
    return join(this.bin, `${engine}-${version}-${platform}-${arch}`)
  },

  /**
   * Get path for a specific container
   * New structure: ~/.spindb/containers/{engine}/{name}/
   */
  getContainerPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    return join(this.containers, engine, name)
  },

  // Get path for container config file
  getContainerConfigPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    return join(this.containers, engine, name, 'container.json')
  },

  // Get path for container data directory
  getContainerDataPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    const engineDef = getEngineDefaults(engine)
    return join(this.containers, engine, name, engineDef.dataSubdir)
  },

  // Get path for container log file
  getContainerLogPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    const engineDef = getEngineDefaults(engine)
    return join(this.containers, engine, name, engineDef.logFileName)
  },

  /**
   * Get path for container PID file
   * Note: For PostgreSQL, PID is inside data dir. For MySQL, it may differ.
   */
  getContainerPidPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    const engineDef = getEngineDefaults(engine)
    // PostgreSQL: data/postmaster.pid
    // MySQL: data/mysql.pid (or just mysql.pid depending on config)
    if (engine === 'postgresql') {
      return join(
        this.containers,
        engine,
        name,
        engineDef.dataSubdir,
        engineDef.pidFileName,
      )
    }
    // MySQL and others: PID file at container level
    return join(this.containers, engine, name, engineDef.pidFileName)
  },

  // Get path for engine-specific containers directory
  getEngineContainersPath(engine: string): string {
    return join(this.containers, engine)
  },

  /**
   * Find all installed binary versions for an engine.
   * Scans the bin directory for directories matching the pattern:
   * {engine}-{version}-{platform}-{arch}
   *
   * @returns Array of { version, path } objects sorted by version descending
   */
  findInstalledBinaries(
    engine: string,
    platform: string,
    arch: string,
  ): Array<{ version: string; path: string }> {
    if (!existsSync(this.bin)) {
      return []
    }

    const suffix = `-${platform}-${arch}`
    const prefix = `${engine}-`

    try {
      const entries = readdirSync(this.bin, { withFileTypes: true })
      const results: Array<{ version: string; path: string }> = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith(prefix)) continue
        if (!entry.name.endsWith(suffix)) continue

        // Extract version from directory name
        // e.g., "postgresql-17.7.0-darwin-arm64" -> "17.7.0"
        const versionPart = entry.name.slice(prefix.length, -suffix.length)
        if (versionPart) {
          results.push({
            version: versionPart,
            path: join(this.bin, entry.name),
          })
        }
      }

      // Sort by version descending (newest first)
      // Handles non-numeric segments (e.g., "1.0.0-beta") by falling back to string comparison
      return results.sort((a, b) => {
        const aParts = a.version.split('.')
        const bParts = b.version.split('.')
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
          const aRaw = aParts[i] || '0'
          const bRaw = bParts[i] || '0'
          const aNum = Number(aRaw)
          const bNum = Number(bRaw)
          // If both are valid numbers, compare numerically
          if (!isNaN(aNum) && !isNaN(bNum)) {
            if (bNum !== aNum) return bNum - aNum
          } else {
            // Fall back to string comparison for non-numeric segments
            const cmp = bRaw.localeCompare(aRaw)
            if (cmp !== 0) return cmp
          }
        }
        return 0
      })
    } catch {
      return []
    }
  },

  /**
   * Find installed binaries for an engine with a specific major version.
   *
   * @returns The newest installed version matching the major version, or null
   */
  findInstalledBinaryForMajor(
    engine: string,
    majorVersion: string,
    platform: string,
    arch: string,
  ): { version: string; path: string } | null {
    const installed = this.findInstalledBinaries(engine, platform, arch)
    const majorPrefix = `${majorVersion}.`

    // Find the first (newest) version that matches the major version
    for (const entry of installed) {
      if (
        entry.version.startsWith(majorPrefix) ||
        entry.version === majorVersion
      ) {
        return entry
      }
    }

    return null
  },
}
