import type { ContainerConfig, Engine } from '../types'
import {
  canDetectMissingDatabase,
  getListingHiddenDatabases,
} from './database-capabilities'
import { logDebug } from './error-handler'

/**
 * Whether a named database exists on a running server.
 * `'unknown'` is never proof of absence: callers must treat it as "could not
 * tell" and keep their existing behavior.
 */
type DatabasePresence = boolean | 'unknown'

type DatabasePresenceProbe = {
  presence: DatabasePresence
  // The engine's user-database listing, or null when it was not consulted or
  // could not be read
  listed: string[] | null
}

// Upper bound on the listing behind a presence probe. The probe runs on every
// start and wake, so a hung client must not stall them; a listing that takes
// longer is reported as 'unknown', which keeps every caller's old behavior.
const DATABASE_PRESENCE_TIMEOUT_MS = 10_000

const LISTING_TIMED_OUT = Symbol('listing-timed-out')

type DatabaseLister = {
  listDatabases(container: ContainerConfig): Promise<string[]>
}

/**
 * Decide presence from an engine's listing. Pure, so the rules are testable
 * without a server:
 * - engines without durable database existence are always 'unknown'
 * - an exact match is present, even when the database holds no data
 * - a name the listing filters out (system databases) is 'unknown'
 * - a case-insensitive-only match is 'unknown' (servers differ on name case)
 */
function classifyDatabasePresence(options: {
  engine: Engine
  name: string
  listed: readonly string[]
}): DatabasePresence {
  const { engine, name, listed } = options
  if (!name || !canDetectMissingDatabase(engine)) return 'unknown'
  if (listed.includes(name)) return true

  const lowered = name.toLowerCase()
  const hidden = getListingHiddenDatabases(engine)
  if (hidden.some((db) => db.toLowerCase() === lowered)) return 'unknown'
  if (listed.some((db) => db.toLowerCase() === lowered)) return 'unknown'

  return false
}

/**
 * Resolve with the listing, or LISTING_TIMED_OUT once `timeoutMs` passes.
 * The timer is unref'd and always cleared, so it can never hold the process
 * open, and a listing that settles after the deadline is ignored.
 */
async function listWithTimeout(options: {
  engine: DatabaseLister
  container: ContainerConfig
  timeoutMs: number
}): Promise<string[] | typeof LISTING_TIMED_OUT> {
  const { engine, container, timeoutMs } = options
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof LISTING_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(LISTING_TIMED_OUT), timeoutMs)
    timer.unref?.()
  })
  try {
    const listing = Promise.resolve(engine.listDatabases(container))
    // A late rejection after the deadline must not surface as unhandled
    listing.catch(() => {})
    return await Promise.race([listing, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe a running server for a named database. Never throws: a failed,
 * malformed, or slow listing (see DATABASE_PRESENCE_TIMEOUT_MS) yields
 * 'unknown', never false.
 */
async function probeDatabasePresence(options: {
  engine: DatabaseLister
  container: ContainerConfig
  name: string
  timeoutMs?: number
}): Promise<DatabasePresenceProbe> {
  const {
    engine,
    container,
    name,
    timeoutMs = DATABASE_PRESENCE_TIMEOUT_MS,
  } = options
  try {
    if (!name || !canDetectMissingDatabase(container.engine)) {
      return { presence: 'unknown', listed: null }
    }
    const listed = await listWithTimeout({ engine, container, timeoutMs })
    if (listed === LISTING_TIMED_OUT) {
      logDebug(
        `listDatabases did not answer within ${timeoutMs}ms; presence of "${name}" is unknown`,
      )
      return { presence: 'unknown', listed: null }
    }
    if (!Array.isArray(listed) || listed.some((db) => typeof db !== 'string')) {
      logDebug(`listDatabases returned a malformed result for ${name}`)
      return { presence: 'unknown', listed: null }
    }
    return {
      presence: classifyDatabasePresence({
        engine: container.engine,
        name,
        listed,
      }),
      listed,
    }
  } catch (error) {
    logDebug(
      `Could not determine whether database "${name}" exists: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { presence: 'unknown', listed: null }
  }
}

export {
  type DatabasePresence,
  type DatabasePresenceProbe,
  type DatabaseLister,
  DATABASE_PRESENCE_TIMEOUT_MS,
  classifyDatabasePresence,
  probeDatabasePresence,
}
