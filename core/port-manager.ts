import net from 'net'
import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { defaults } from '../config/defaults'
import { paths } from '../config/paths'
import type { ContainerConfig, PortResult } from '../types'

const execAsync = promisify(exec)

export class PortManager {
  /**
   * Check if a specific port is available
   */
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()

      server.once('error', (err: NodeJS.ErrnoException) => {
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

  /**
   * Find the next available port starting from the default
   * Returns the port number and whether it's the default port
   */
  async findAvailablePort(
    preferredPort: number = defaults.port,
  ): Promise<PortResult> {
    // First try the preferred port
    if (await this.isPortAvailable(preferredPort)) {
      return {
        port: preferredPort,
        isDefault: preferredPort === defaults.port,
      }
    }

    // Scan for available ports in the range
    for (
      let port = defaults.portRange.start;
      port <= defaults.portRange.end;
      port++
    ) {
      if (port === preferredPort) continue // Already tried this one

      if (await this.isPortAvailable(port)) {
        return {
          port,
          isDefault: false,
        }
      }
    }

    throw new Error(
      `No available ports found in range ${defaults.portRange.start}-${defaults.portRange.end}`,
    )
  }

  /**
   * Get what's using a specific port (for diagnostics)
   */
  async getPortUser(port: number): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`lsof -i :${port} -P -n | head -5`)
      return stdout.trim()
    } catch {
      return null
    }
  }

  /**
   * Get all ports currently assigned to containers
   */
  async getContainerPorts(): Promise<number[]> {
    const containersDir = paths.containers

    if (!existsSync(containersDir)) {
      return []
    }

    const ports: number[] = []
    const entries = await readdir(containersDir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const configPath = `${containersDir}/${entry.name}/container.json`
        if (existsSync(configPath)) {
          try {
            const content = await readFile(configPath, 'utf8')
            const config = JSON.parse(content) as ContainerConfig
            ports.push(config.port)
          } catch {
            // Skip invalid configs
          }
        }
      }
    }

    return ports
  }

  /**
   * Find an available port that's not in use by any process AND not assigned to any container
   */
  async findAvailablePortExcludingContainers(
    preferredPort: number = defaults.port,
  ): Promise<PortResult> {
    const containerPorts = await this.getContainerPorts()

    // First try the preferred port
    if (
      !containerPorts.includes(preferredPort) &&
      (await this.isPortAvailable(preferredPort))
    ) {
      return {
        port: preferredPort,
        isDefault: preferredPort === defaults.port,
      }
    }

    // Scan for available ports in the range
    for (
      let port = defaults.portRange.start;
      port <= defaults.portRange.end;
      port++
    ) {
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
      `No available ports found in range ${defaults.portRange.start}-${defaults.portRange.end}`,
    )
  }
}

export const portManager = new PortManager()
