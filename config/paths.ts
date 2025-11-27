import { homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { getEngineDefaults } from './engine-defaults'

/**
 * Get the real user's home directory, even when running under sudo.
 * When a user runs `sudo spindb`, we want to use their home directory,
 * not root's home directory.
 */
function getRealHomeDir(): string {
  // Check if running under sudo
  const sudoUser = process.env.SUDO_USER

  if (sudoUser) {
    // Get the original user's home directory
    try {
      // Use getent to reliably get the home directory for the sudo user
      const result = execSync(`getent passwd ${sudoUser}`, {
        encoding: 'utf-8',
      })
      const parts = result.trim().split(':')
      if (parts.length >= 6 && parts[5]) {
        return parts[5]
      }
    } catch {
      // Fall back to constructing the path
      // On most Linux systems, home dirs are /home/username
      // On macOS, they're /Users/username
      const platform = process.platform
      if (platform === 'darwin') {
        return `/Users/${sudoUser}`
      } else {
        return `/home/${sudoUser}`
      }
    }
  }

  // Not running under sudo, use normal homedir
  return homedir()
}

const SPINDB_HOME = join(getRealHomeDir(), '.spindb')

/**
 * Options for container path functions
 */
type ContainerPathOptions = {
  engine: string
}

/**
 * Options for binary path functions
 */
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

  /**
   * Get path for a specific binary version
   */
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

  /**
   * Get path for container config file
   */
  getContainerConfigPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    return join(this.containers, engine, name, 'container.json')
  },

  /**
   * Get path for container data directory
   */
  getContainerDataPath(name: string, options: ContainerPathOptions): string {
    const { engine } = options
    const engineDef = getEngineDefaults(engine)
    return join(this.containers, engine, name, engineDef.dataSubdir)
  },

  /**
   * Get path for container log file
   */
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

  /**
   * Get path for engine-specific containers directory
   */
  getEngineContainersPath(engine: string): string {
    return join(this.containers, engine)
  },
}
