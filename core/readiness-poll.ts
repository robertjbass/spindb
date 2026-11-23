/**
 * Readiness polling for server starts.
 *
 * Checks immediately, then retries with a short delay that doubles up to a
 * ceiling, until the check passes or the deadline passes. A fast server is
 * seen ready within tens of milliseconds instead of after a fixed sleep,
 * while a slow one is polled no more often than every `maxDelayMs`.
 */

import net from 'net'
import { setTimeout as delay } from 'timers/promises'

const DEFAULT_INITIAL_DELAY_MS = 50
const DEFAULT_MAX_DELAY_MS = 250

export type PollUntilReadyOptions = {
  // Total time allowed, measured from the first check
  timeoutMs: number
  initialDelayMs?: number
  maxDelayMs?: number
  // Ends the poll early (for example when the server process failed to spawn)
  shouldStop?: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Run `check` until it resolves true. A check that throws or resolves false
 * counts as not ready. Resolves true once ready, false on timeout or stop.
 */
export async function pollUntilReady(
  check: () => Promise<boolean>,
  options: PollUntilReadyOptions,
): Promise<boolean> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => delay(ms))
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const deadline = now() + options.timeoutMs
  let nextDelayMs = Math.min(
    options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs,
  )

  while (!options.shouldStop?.()) {
    try {
      if (await check()) return true
    } catch {
      // Not ready yet
    }
    if (options.shouldStop?.()) return false
    const remainingMs = deadline - now()
    if (remainingMs <= 0) return false
    await sleep(Math.min(nextDelayMs, remainingMs))
    nextDelayMs = Math.min(nextDelayMs * 2, maxDelayMs)
  }
  return false
}

/**
 * True when a TCP connection to host:port is accepted. Proves only that a
 * listener exists; callers still run their real readiness check afterward.
 */
export function isTcpPortAccepting(options: {
  port: number
  host?: string
  timeoutMs?: number
}): Promise<boolean> {
  const { port, host = '127.0.0.1', timeoutMs = 1000 } = options
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const finish = (accepting: boolean) => {
      socket.destroy()
      resolve(accepting)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}
