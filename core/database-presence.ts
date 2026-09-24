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
 * Probe a running server for a named database. Never throws: a failed or
 * malformed listing yields 'unknown', never false.
 */
async function probeDatabasePresence(options: {
  engine: DatabaseLister
  container: ContainerConfig
  name: string
}): Promise<DatabasePresenceProbe> {
  const { engine, container, name } = options
  try {
    if (!name || !canDetectMissingDatabase(container.engine)) {
      return { presence: 'unknown', listed: null }
    }
    const listed = await engine.listDatabases(container)
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
  classifyDatabasePresence,
  probeDatabasePresence,
}
