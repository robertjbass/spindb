import { describe, it } from 'node:test'
import { selectContainerForWhich } from '../../cli/commands/which'
import { Engine, type ContainerConfig } from '../../types'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

function container(
  overrides: Partial<ContainerConfig> & {
    name: string
    port: number
    status: ContainerConfig['status']
  },
): ContainerConfig {
  return {
    engine: Engine.PostgreSQL,
    version: '17.7.0',
    database: overrides.database ?? overrides.name,
    created: '2026-04-20T00:00:00Z',
    ...overrides,
  }
}

describe('selectContainerForWhich', () => {
  it('prefers a running container over a stopped one on the same port', () => {
    // Regression: `containers.find(c => c.port === target)` used to return the
    // first hit, which could be a stopped container even when a running one
    // was present. Fixed by ranking running > stopped.
    const containers = [
      container({ name: 'efficient', port: 5433, status: 'stopped' }),
      container({ name: 'offlabelinsight', port: 5433, status: 'running' }),
    ]
    const match = selectContainerForWhich(containers, { targetPort: 5433 })
    assertEqual(
      match?.name,
      'offlabelinsight',
      'Should pick the running container even when it is not first in the list',
    )
  })

  it('prefers a running container that hosts the target database', () => {
    // Two running containers share a port — pick the one that actually has the
    // requested database on it.
    const containers = [
      container({
        name: 'layerbase',
        port: 5433,
        status: 'running',
        database: 'layerbase',
        databases: ['layerbase'],
      }),
      container({
        name: 'offlabelinsight',
        port: 5433,
        status: 'running',
        database: 'offlabelinsight',
        databases: ['offlabelinsight'],
      }),
    ]
    const match = selectContainerForWhich(containers, {
      targetPort: 5433,
      targetDatabase: 'offlabelinsight',
    })
    assertEqual(
      match?.name,
      'offlabelinsight',
      'Should pick the container that hosts the requested database',
    )
  })

  it('prefers running+hosts-database over either alone', () => {
    const containers = [
      // stopped but has the DB
      container({
        name: 'legacy',
        port: 5433,
        status: 'stopped',
        databases: ['offlabelinsight'],
      }),
      // running but different DB
      container({
        name: 'other',
        port: 5433,
        status: 'running',
        databases: ['other'],
      }),
      // running AND has the DB — the winner
      container({
        name: 'winner',
        port: 5433,
        status: 'running',
        databases: ['offlabelinsight'],
      }),
    ]
    const match = selectContainerForWhich(containers, {
      targetPort: 5433,
      targetDatabase: 'offlabelinsight',
    })
    assertEqual(match?.name, 'winner', 'Should prefer running+hosts')
  })

  it('falls back to the first candidate when nothing distinguishes them', () => {
    const containers = [
      container({ name: 'a', port: 5433, status: 'stopped' }),
      container({ name: 'b', port: 5433, status: 'stopped' }),
    ]
    const match = selectContainerForWhich(containers, { targetPort: 5433 })
    assertEqual(
      match?.name,
      'a',
      'Should be stable — first candidate wins on a tie',
    )
  })

  it('returns null when no container matches the port', () => {
    const containers = [
      container({ name: 'a', port: 5432, status: 'running' }),
    ]
    const match = selectContainerForWhich(containers, { targetPort: 9999 })
    assertNullish(match, 'Should return null when nothing matches')
  })

  it('honors the running-only filter', () => {
    const containers = [
      container({ name: 'stopped-one', port: 5433, status: 'stopped' }),
    ]
    const match = selectContainerForWhich(containers, {
      targetPort: 5433,
      runningOnly: true,
    })
    assertNullish(
      match,
      'runningOnly must exclude stopped containers even when they match port',
    )
  })

  it('filters by engine before ranking', () => {
    const containers = [
      container({
        name: 'pg',
        port: 5432,
        status: 'running',
        engine: Engine.PostgreSQL,
      }),
      container({
        name: 'mysql',
        port: 5432,
        status: 'running',
        engine: Engine.MySQL,
      }),
    ]
    const match = selectContainerForWhich(containers, {
      targetPort: 5432,
      targetEngine: Engine.MySQL,
    })
    assertEqual(match?.name, 'mysql', 'Engine filter should apply before rank')
  })

  it('does not award the database bonus when target is undefined', () => {
    // Edge case: with no target database, a running container must not get
    // "bumped up" by coincidentally having a database that happens to match
    // a property on the request (which is undefined in this case).
    const containers = [
      container({
        name: 'a',
        port: 5433,
        status: 'running',
        databases: ['anything'],
      }),
      container({
        name: 'b',
        port: 5433,
        status: 'running',
        databases: ['something'],
      }),
    ]
    const match = selectContainerForWhich(containers, { targetPort: 5433 })
    assertEqual(match?.name, 'a', 'Ties on score resolve to first candidate')
    assert(match !== null, 'A running match should still be found')
  })
})
