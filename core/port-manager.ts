import net from 'net'
import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { defaults, getSupportedEngines } from '../config/defaults'
import { paths } from '../config/paths'
import { logDebug } from './error-handler'
import type { ContainerConfig, PortResult } from '../types'

const execAsync = promisify(exec)

type FindPortOptions = {
  preferredPort?: number
  portRange?: { start: number; end: number }
}

export class PortManager {
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()

      server.once('error', (err: NodeJS.ErrnoException) => {
        // Always close the server to prevent resource leaks
        server.close()
        if (err.code === 'EADDRINUSE') {
          resolve(false)
        } else {
          // Other errors - assume port is available
          resolve(true)
        }
      })

      server.once('listening', () => {
        server.close()
        resolve(true)
      })

      server.listen(port, '127.0.0.1')
    })
  }

  async findAvailablePort(options: FindPortOptions = {}): Promise<PortResult> {
    const preferredPort = options.preferredPort ?? defaults.port
    const portRange = options.portRange ?? defaults.portRange

    // First try the preferred port
    if (await this.isPortAvailable(preferredPort)) {
      return {
        port: preferredPort,
        isDefault: true, // We got the preferred port
      }
    }

    // Scan for available ports in the range
    for (let port = portRange.start; port <= portRange.end; port++) {
      if (port === preferredPort) continue // Already tried this one

      if (await this.isPortAvailable(port)) {
        return {
          port,
          isDefault: false,
        }
      }
    }

    throw new Error(
      `No available ports found in range ${portRange.start}-${portRange.end}`,
    )
  }

  async getPortUser(port: number): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`lsof -i :${port} -P -n | head -5`)
      return stdout.trim()
    } catch (error) {
      logDebug('Could not determine port user', {
        port,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  async getContainerPorts(): Promise<number[]> {
    const containersDir = paths.containers

    if (!existsSync(containersDir)) {
      return []
    }

    const ports: number[] = []
    const engines = getSupportedEngines()

    for (const engine of engines) {
      const engineDir = paths.getEngineContainersPath(engine)
      if (!existsSync(engineDir)) continue

      const entries = await readdir(engineDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const configPath = paths.getContainerConfigPath(entry.name, {
            engine,
          })
          if (existsSync(configPath)) {
            try {
              const content = await readFile(configPath, 'utf8')
              const config = JSON.parse(content) as ContainerConfig
              // Only include ports from running containers
              // Stopped containers don't block ports - users can manage conflicts themselves
              if (config.status === 'running') {
                ports.push(config.port)
              }
            } catch (error) {
              logDebug('Skipping invalid container config', {
                configPath,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
      }
    }

    return ports
  }

  async findAvailablePortExcludingContainers(
    options: FindPortOptions = {},
  ): Promise<PortResult> {
    const preferredPort = options.preferredPort ?? defaults.port
    const portRange = options.portRange ?? defaults.portRange
    const containerPorts = await this.getContainerPorts()

    // First try the preferred port
    if (
      !containerPorts.includes(preferredPort) &&
      (await this.isPortAvailable(preferredPort))
    ) {
      return {
        port: preferredPort,
        isDefault: true, // We got the preferred port
      }
    }

    // Scan for available ports in the range
    for (let port = portRange.start; port <= portRange.end; port++) {
      if (containerPorts.includes(port)) continue // Skip ports used by containers
      if (port === preferredPort) continue // Already tried this one

      if (await this.isPortAvailable(port)) {
        return {
          port,
          isDefault: false,
        }
      }
    }

    throw new Error(
      `No available ports found in range ${portRange.start}-${portRange.end}`,
    )
  }
}

export const portManager = new PortManager()
