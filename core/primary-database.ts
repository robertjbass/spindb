import type { ContainerConfig } from '../types'
import {
  canCreateDatabase,
  canDetectMissingDatabase,
} from './database-capabilities'
import type { DatabasePresence } from './database-presence'

/**
 * What start found (and did) for the container's primary database:
 * - present: the server listed it before start touched it
 * - created: first start of a container created with --no-start; the
 *   database never existed, so creating it is not a recreation
 * - recreated: it was missing and start created it again, empty
 * - missing: it is missing and start left it that way
 * - unknown: the engine cannot tell, or the listing failed
 */
type PrimaryDatabaseState =
  | 'present'
  | 'created'
  | 'recreated'
  | 'missing'
  | 'unknown'

type PrimaryDatabaseReport = {
  name: string
  state: PrimaryDatabaseState
}

// What happened to the ensure-database step. 'not-applicable' matches the
// engines and names the ensure block has always skipped.
type EnsureOutcome =
  | { kind: 'not-applicable' }
  | { kind: 'skipped-missing' }
  | { kind: 'skipped-unknown' }
  | { kind: 'ready'; alreadyExisted: boolean }
  | { kind: 'failed'; message: string }

type PrimaryDatabaseEngine = {
  databaseExists(
    container: ContainerConfig,
    name: string,
  ): Promise<DatabasePresence>
  createDatabase(container: ContainerConfig, database: string): Promise<void>
}

type EnsurePrimaryDatabaseResult = {
  primaryDatabase: PrimaryDatabaseReport
  ensure: EnsureOutcome
}

/**
 * Probe the primary database, then run the ensure-database step start has
 * always run. With `recreate` (the default) a missing database is created as
 * before and reported as 'recreated'. Without it, an engine that can detect
 * absence leaves the database missing (or skips the create when it could not
 * tell) instead of creating an empty one. Engines that cannot detect absence
 * keep the old behavior regardless of `recreate` and report 'unknown'.
 *
 * `firstStart` is a container that has never been started (created with
 * --no-start). Its database was never there, so it is always created and
 * reported as 'created', whatever `recreate` says.
 */
async function ensurePrimaryDatabase(options: {
  engine: PrimaryDatabaseEngine
  config: ContainerConfig
  superuser: string
  recreate: boolean
  firstStart: boolean
  onEnsureStart?: () => void
}): Promise<EnsurePrimaryDatabaseResult> {
  const { engine, config, superuser, recreate, firstStart, onEnsureStart } =
    options
  const name = config.database ?? ''
  const detectable = Boolean(name) && canDetectMissingDatabase(config.engine)

  const presence: DatabasePresence = detectable
    ? await engine.databaseExists(config, name)
    : 'unknown'

  const ensureApplicable =
    canCreateDatabase(config.engine) && Boolean(name) && name !== superuser

  const leaveMissing = detectable && !recreate && !firstStart

  let ensure: EnsureOutcome
  if (!ensureApplicable) {
    ensure = { kind: 'not-applicable' }
  } else if (leaveMissing && presence === false) {
    ensure = { kind: 'skipped-missing' }
  } else if (leaveMissing && presence === 'unknown') {
    ensure = { kind: 'skipped-unknown' }
  } else {
    onEnsureStart?.()
    try {
      await engine.createDatabase(config, name)
      ensure = { kind: 'ready', alreadyExisted: false }
    } catch (error) {
      const message = (error as Error)?.message ?? ''
      ensure = /already exists/i.test(message)
        ? { kind: 'ready', alreadyExisted: true }
        : { kind: 'failed', message }
    }
  }

  return {
    primaryDatabase: {
      name,
      state: resolvePrimaryDatabaseState({ presence, ensure, firstStart }),
    },
    ensure,
  }
}

function resolvePrimaryDatabaseState(options: {
  presence: DatabasePresence
  ensure: EnsureOutcome
  firstStart: boolean
}): PrimaryDatabaseState {
  const { presence, ensure, firstStart } = options
  if (presence === true) return 'present'
  if (presence === 'unknown') return 'unknown'

  // The listing proved the database absent before the ensure step ran
  switch (ensure.kind) {
    case 'ready':
      // A create that reports "already exists" means it appeared in between
      if (ensure.alreadyExisted) return 'present'
      return firstStart ? 'created' : 'recreated'
    case 'not-applicable':
    case 'skipped-missing':
    case 'skipped-unknown':
    case 'failed':
      return 'missing'
  }
}

export {
  type PrimaryDatabaseState,
  type PrimaryDatabaseReport,
  type EnsureOutcome,
  type EnsurePrimaryDatabaseResult,
  ensurePrimaryDatabase,
  resolvePrimaryDatabaseState,
}
