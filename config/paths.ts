import { homedir } from 'os'
import { join } from 'path'

const SPINDB_HOME = join(homedir(), '.spindb')

export const paths = {
  // Root directory for all spindb data
  root: SPINDB_HOME,

  // Directory for downloaded database binaries
  bin: join(SPINDB_HOME, 'bin'),

  // Directory for container data
  containers: join(SPINDB_HOME, 'containers'),

  // Global config file
  config: join(SPINDB_HOME, 'config.json'),

  // Get path for a specific binary version
  getBinaryPath(
    engine: string,
    version: string,
    platform: string,
    arch: string,
  ): string {
    return join(this.bin, `${engine}-${version}-${platform}-${arch}`)
  },

  // Get path for a specific container
  getContainerPath(name: string): string {
    return join(this.containers, name)
  },

  // Get path for container config
  getContainerConfigPath(name: string): string {
    return join(this.containers, name, 'container.json')
  },

  // Get path for container data directory
  getContainerDataPath(name: string): string {
    return join(this.containers, name, 'data')
  },

  // Get path for container log file
  getContainerLogPath(name: string): string {
    return join(this.containers, name, 'postgres.log')
  },

  // Get path for container PID file
  getContainerPidPath(name: string): string {
    return join(this.containers, name, 'data', 'postmaster.pid')
  },
}
