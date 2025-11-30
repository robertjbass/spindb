/**
 * Start with Retry
 *
 * Handles port race conditions by automatically retrying with a new port
 * when the original port becomes unavailable between check and bind.
 */

import { portManager } from './port-manager'
import { containerManager } from './container-manager'
import { logWarning, logDebug } from './error-handler'
import type { BaseEngine } from '../engines/base-engine'
import { getEngineDefaults } from '../config/defaults'
import type { ContainerConfig } from '../types'

export type StartWithRetryOptions = {
  engine: BaseEngine
  config: ContainerConfig
  maxRetries?: number // Default: 3
  onPortChange?: (oldPort: number, newPort: number) => void
}

export type StartWithRetryResult = {
  success: boolean
  finalPort: number
  retriesUsed: number
  error?: Error
}

function isPortInUseError(err: unknown): boolean {
  const message = (err as Error)?.message?.toLowerCase() || ''
  return (
    message.includes('address already in use') ||
    message.includes('eaddrinuse') ||
    (message.includes('port') && message.includes('in use')) ||
    message.includes('could not bind') ||
    message.includes('socket already in use')
  )
}

/**
 * Start a database container with automatic port retry on conflict
 *
 * This handles the race condition where a port is available when checked
 * but taken by the time the database server tries to bind to it.
 */
export async function startWithRetry(
  options: StartWithRetryOptions,
): Promise<StartWithRetryResult> {
  const { engine, config, maxRetries = 3, onPortChange } = options

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logDebug(`Starting ${engine.name} (attempt ${attempt}/${maxRetries})`, {
        containerName: config.name,
        port: config.port,
      })

      await engine.start(config)

      return {
        success: true,
        finalPort: config.port,
        retriesUsed: attempt - 1,
      }
    } catch (err) {
      const isPortError = isPortInUseError(err)

      logDebug(`Start attempt ${attempt} failed`, {
        containerName: config.name,
        port: config.port,
        isPortError,
        error: err instanceof Error ? err.message : String(err),
      })

      if (isPortError && attempt < maxRetries) {
        const oldPort = config.port

        // Find a new available port, excluding the one that just failed
        const { port: newPort } = await portManager.findAvailablePort({
          portRange: getEnginePortRange(config.engine),
        })

        // Update config with new port
        config.port = newPort
        await containerManager.updateConfig(config.name, { port: newPort })

        // Notify caller of port change
        if (onPortChange) {
          onPortChange(oldPort, newPort)
        }

        // Log and retry
        logWarning(
          `Port ${oldPort} is in use, retrying with port ${newPort}...`,
        )
        continue
      }

      // Not a port error or max retries exceeded
      return {
        success: false,
        finalPort: config.port,
        retriesUsed: attempt - 1,
        error: err instanceof Error ? err : new Error(String(err)),
      }
    }
  }

  // Should never reach here, but TypeScript needs a return
  return {
    success: false,
    finalPort: config.port,
    retriesUsed: maxRetries,
    error: new Error('Max retries exceeded'),
  }
}

function getEnginePortRange(engine: string): { start: number; end: number } {
  const engineDefaults = getEngineDefaults(engine)
  return engineDefaults.portRange
}

/**
 * Wrapper that simplifies the common use case
 */
export async function startContainerWithRetry(
  engine: BaseEngine,
  config: ContainerConfig,
  options?: {
    onPortChange?: (oldPort: number, newPort: number) => void
  },
): Promise<void> {
  const result = await startWithRetry({
    engine,
    config,
    onPortChange: options?.onPortChange,
  })

  if (!result.success && result.error) {
    throw result.error
  }
}
