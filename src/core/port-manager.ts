import net from 'net'
import { exec } from 'child_process'
import { promisify } from 'util'
import { defaults } from '@/config/defaults'
import type { PortResult } from '@/types'

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
}

export const portManager = new PortManager()
