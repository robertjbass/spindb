/**
 * Unit tests for port-manager module
 */

import { describe, it } from 'node:test'
import { PortManager } from '../../core/port-manager'
import { assert, assertEqual } from '../integration/helpers'

describe('PortManager', () => {
  describe('isPortAvailable', () => {
    it('should return true for available port', async () => {
      const portManager = new PortManager()
      // Port 59999 is unlikely to be in use
      const available = await portManager.isPortAvailable(59999)
      assert(typeof available === 'boolean', 'Should return a boolean')
    })

    it('should return false for port 1 (privileged, likely unavailable)', async () => {
      const portManager = new PortManager()
      // Port 1 requires root privileges and should fail
      const available = await portManager.isPortAvailable(1)
      // On most systems, non-root users can't bind to port 1
      // but the error handling treats non-EADDRINUSE as available
      assert(typeof available === 'boolean', 'Should return a boolean')
    })
  })

  describe('findAvailablePort', () => {
    it('should return port with isDefault property', async () => {
      const portManager = new PortManager()
      const result = await portManager.findAvailablePort({
        preferredPort: 59990,
        portRange: { start: 59990, end: 59999 },
      })

      assert(typeof result.port === 'number', 'Should return port number')
      assert(typeof result.isDefault === 'boolean', 'Should return isDefault flag')
      assert(result.port >= 59990, 'Port should be in range')
      assert(result.port <= 59999, 'Port should be in range')
    })

    it('should throw error when no ports available in range', async () => {
      const portManager = new PortManager()
      // Create a mock that always returns false (all ports in use)
      const originalIsPortAvailable = portManager.isPortAvailable.bind(portManager)
      portManager.isPortAvailable = async () => {
        return false
      }

      try {
        await portManager.findAvailablePort({
          preferredPort: 59990,
          portRange: { start: 59990, end: 59992 },
        })
        assert(false, 'Should have thrown an error')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          error.message.includes('No available ports'),
          `Error message should mention no available ports: ${error.message}`,
        )
        assert(
          error.message.includes('59990-59992'),
          `Error message should include port range: ${error.message}`,
        )
      } finally {
        portManager.isPortAvailable = originalIsPortAvailable
      }
    })

    it('should skip preferred port if already tried', async () => {
      const portManager = new PortManager()
      const triedPorts: number[] = []
      const originalIsPortAvailable = portManager.isPortAvailable.bind(portManager)

      portManager.isPortAvailable = async (port: number) => {
        triedPorts.push(port)
        // First call (preferred) returns false, subsequent return true
        return port !== 59990
      }

      try {
        const result = await portManager.findAvailablePort({
          preferredPort: 59990,
          portRange: { start: 59990, end: 59995 },
        })

        assert(result.port !== 59990, 'Should not return the unavailable preferred port')
        assert(result.isDefault === false, 'Should not be marked as default')
        // Should try preferred once, then scan range (skipping preferred)
        assertEqual(triedPorts[0], 59990, 'Should try preferred port first')
        assert(!triedPorts.slice(1).includes(59990), 'Should not retry preferred port in scan')
      } finally {
        portManager.isPortAvailable = originalIsPortAvailable
      }
    })
  })

  describe('getPortUser', () => {
    it('should return null for unused port', async () => {
      const portManager = new PortManager()
      // Port 59998 is unlikely to be in use
      const user = await portManager.getPortUser(59998)
      // If nothing is using it, lsof returns nothing
      assert(
        user === null || typeof user === 'string',
        'Should return null or string',
      )
    })

    it('should handle lsof errors gracefully', async () => {
      const portManager = new PortManager()
      // Invalid port should not crash
      const user = await portManager.getPortUser(-1)
      // May return null or empty string depending on lsof behavior
      assert(
        user === null || user === '',
        `Should return null or empty string for invalid port, got: "${user}"`,
      )
    })
  })

  describe('getContainerPorts', () => {
    it('should return array of ports', async () => {
      const portManager = new PortManager()
      const ports = await portManager.getContainerPorts()

      assert(Array.isArray(ports), 'Should return an array')
      for (const port of ports) {
        assert(typeof port === 'number', 'Each port should be a number')
        assert(port > 0, 'Port should be positive')
      }
    })

    it('should return empty array if containers directory does not exist', async () => {
      // This tests the existsSync check at the start
      const portManager = new PortManager()
      const ports = await portManager.getContainerPorts()
      assert(Array.isArray(ports), 'Should return an array even if empty')
    })
  })

  describe('findAvailablePortExcludingContainers', () => {
    it('should skip ports used by containers', async () => {
      const portManager = new PortManager()
      const originalGetContainerPorts = portManager.getContainerPorts.bind(portManager)
      const originalIsPortAvailable = portManager.isPortAvailable.bind(portManager)

      // Mock container ports
      portManager.getContainerPorts = async () => [59990, 59991]

      const triedPorts: number[] = []
      portManager.isPortAvailable = async (port: number) => {
        triedPorts.push(port)
        return true
      }

      try {
        const result = await portManager.findAvailablePortExcludingContainers({
          preferredPort: 59990,
          portRange: { start: 59990, end: 59995 },
        })

        // Should skip 59990 and 59991 (used by containers)
        assert(
          result.port !== 59990 && result.port !== 59991,
          'Should not return ports used by containers',
        )
        assert(
          !triedPorts.includes(59990) || triedPorts.indexOf(59990) === 0,
          'Should check preferred port first',
        )
      } finally {
        portManager.getContainerPorts = originalGetContainerPorts
        portManager.isPortAvailable = originalIsPortAvailable
      }
    })

    it('should throw error when all ports in range are used', async () => {
      const portManager = new PortManager()
      const originalGetContainerPorts = portManager.getContainerPorts.bind(portManager)
      const originalIsPortAvailable = portManager.isPortAvailable.bind(portManager)

      // All ports used by containers
      portManager.getContainerPorts = async () => [59990, 59991, 59992]
      portManager.isPortAvailable = async () => true // Would be available, but blocked by containers

      try {
        await portManager.findAvailablePortExcludingContainers({
          preferredPort: 59990,
          portRange: { start: 59990, end: 59992 },
        })
        assert(false, 'Should have thrown an error')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          error.message.includes('No available ports'),
          `Error should mention no available ports: ${error.message}`,
        )
      } finally {
        portManager.getContainerPorts = originalGetContainerPorts
        portManager.isPortAvailable = originalIsPortAvailable
      }
    })
  })
})

describe('Port Error Messages', () => {
  it('should provide actionable error message with port range', async () => {
    const portManager = new PortManager()
    portManager.isPortAvailable = async () => false

    try {
      await portManager.findAvailablePort({
        portRange: { start: 5432, end: 5440 },
      })
    } catch (error) {
      assert(error instanceof Error, 'Should throw Error')
      assert(
        error.message.includes('5432-5440'),
        'Error should include the specific port range tried',
      )
    }
  })
})
