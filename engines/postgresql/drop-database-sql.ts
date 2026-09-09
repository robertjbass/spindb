/**
 * The SQL a PostgreSQL drop needs, and the version gate in front of it.
 *
 * PostgreSQL refuses `DROP DATABASE` while any session is attached to the
 * target ("database <name> is being accessed by other users"). Terminating the
 * attached backends first and then dropping is the classic workaround, but it
 * is a race, not a fix: between the terminate and the drop, anything that
 * reconnects on its own - a pgbouncer pool re-opening its server connection, a
 * query console, the customer's app - re-attaches and the drop fails again.
 * That is how `spindb restore --force` over a live cloud database failed three
 * times in a row for one migration.
 *
 * PostgreSQL 13 added `DROP DATABASE ... WITH (FORCE)`, which terminates the
 * sessions inside the same statement, so there is no window to reconnect in.
 * Use it wherever it exists; keep the two-step (plus one retry) for older
 * servers, which have nothing better.
 *
 * These builders are pure so the gate itself is unit-testable without a server.
 */

/** First major version that understands `DROP DATABASE ... WITH (FORCE)`. */
export const DROP_FORCE_MIN_MAJOR = 13

/** How long to wait before the one retry the two-step path gets. */
export const DROP_RETRY_DELAY_MS = 500

/**
 * Major version number out of a container's recorded version string.
 *
 * Accepts what container.json actually holds: a pinned full version
 * ('18.4.0'), legacy shorthand ('18'), and pre-10 shapes ('9.6.24' -> 9,
 * which is below the gate either way). Returns null for 'unknown', an empty
 * value, or anything that does not start with digits - the caller then treats
 * the server as too old to force, which is the safe direction.
 */
export function parsePostgresMajor(version?: string | null): number | null {
  if (!version) return null
  const match = /^(\d+)/.exec(version.trim())
  if (!match) return null
  const major = Number(match[1])
  return Number.isInteger(major) && major > 0 ? major : null
}

/** Whether this server can drop with FORCE. Unknown version = no. */
export function supportsDropForce(major: number | null): boolean {
  return major !== null && major >= DROP_FORCE_MIN_MAJOR
}

/**
 * `DROP DATABASE` statement for a server of this vintage.
 *
 * The name is quoted (and validated by the caller through
 * assertValidDatabaseName), IF EXISTS keeps a repeat drop harmless.
 */
export function buildDropDatabaseSql(
  database: string,
  options: { force: boolean },
): string {
  return options.force
    ? `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`
    : `DROP DATABASE IF EXISTS "${database}"`
}

/**
 * Terminate every backend attached to `database` except the connection issuing
 * the statement - the two-step path's first step, and what renameDatabase
 * needs on every version (ALTER DATABASE has no FORCE).
 */
export function buildTerminateConnectionsSql(database: string): string {
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`
}

/**
 * The database to connect to in order to drop `database`.
 *
 * A drop can never run from inside its own target, so admin statements go to
 * 'postgres'. Dropping 'postgres' itself (possible on a server whose default
 * maintenance database was recreated) has to run from somewhere else.
 */
export function maintenanceDatabaseFor(database: string): string {
  return database === 'postgres' ? 'template1' : 'postgres'
}

/** "database ... is being accessed by other users" - the retryable one. */
export function isDatabaseInUseError(message: string): boolean {
  return /is being accessed by other users/i.test(message)
}

/** "database ... does not exist" - nothing to drop, treat as done. */
export function isDatabaseMissingError(message: string): boolean {
  return /does not exist/i.test(message)
}

/**
 * A server that does not understand WITH (FORCE) after all - the recorded
 * container version said 13+ but the binary answering is older (a container
 * created before versions were pinned, a binary swapped underneath). Fall back
 * to the two-step rather than reporting a syntax error as a drop failure.
 */
export function isDropForceUnsupportedError(message: string): boolean {
  return (
    /syntax error at or near "?FORCE/i.test(message) ||
    /unrecognized DROP DATABASE option/i.test(message) ||
    /option "?force"? is not recognized/i.test(message)
  )
}
