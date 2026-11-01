import { describe, it } from 'node:test'
import {
  buildSqldArgs,
  SQLD_CHECKPOINT_INTERVAL_SECONDS,
  SQLD_MAX_RESPONSE_SIZE,
  SQLD_MAX_TOTAL_RESPONSE_SIZE,
} from '../../engines/libsql/sqld-args'
import { assert, assertEqual } from '../utils/assertions'

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function megabytes(size: string): number {
  const match = /^(\d+)MB$/.exec(size)
  assert(match !== null, `expected an NMB size, got ${size}`)
  return Number(match![1])
}

describe('buildSqldArgs', () => {
  it('always switches sqld to time-based TRUNCATE checkpoints', () => {
    const args = buildSqldArgs({
      bindAddress: '127.0.0.1',
      port: 8080,
      dbPath: '/data/data.db',
    })
    assertEqual(
      flagValue(args, '--checkpoint-interval-s'),
      String(SQLD_CHECKPOINT_INTERVAL_SECONDS),
      'checkpoint interval flag must be set on every start',
    )
    assert(
      SQLD_CHECKPOINT_INTERVAL_SECONDS > 0,
      'a zero interval would not disable frame-count auto-checkpoint',
    )
  })

  it('raises the response size limits so a 50 MB result is served', () => {
    const args = buildSqldArgs({
      bindAddress: '127.0.0.1',
      port: 8080,
      dbPath: '/data/data.db',
    })
    assertEqual(
      flagValue(args, '--max-response-size'),
      SQLD_MAX_RESPONSE_SIZE,
      'per-response limit flag must be set on every start',
    )
    assertEqual(
      flagValue(args, '--max-total-response-size'),
      SQLD_MAX_TOTAL_RESPONSE_SIZE,
      'total limit flag must be set on every start',
    )
    assert(
      megabytes(SQLD_MAX_TOTAL_RESPONSE_SIZE) >=
        megabytes(SQLD_MAX_RESPONSE_SIZE),
      'a total below the per-response limit makes one maximum response fail',
    )
  })

  it('binds the listen address and data path', () => {
    const args = buildSqldArgs({
      bindAddress: '0.0.0.0',
      port: 41234,
      dbPath: '/data/data.db',
    })
    assertEqual(
      flagValue(args, '--http-listen-addr'),
      '0.0.0.0:41234',
      'listen addr',
    )
    assertEqual(flagValue(args, '--db-path'), '/data/data.db', 'db path')
  })

  it('adds the JWT key only when one exists', () => {
    const withoutKey = buildSqldArgs({
      bindAddress: '127.0.0.1',
      port: 8080,
      dbPath: '/data/data.db',
    })
    assertEqual(
      flagValue(withoutKey, '--auth-jwt-key-file'),
      undefined,
      'no key flag without a key',
    )
    const withKey = buildSqldArgs({
      bindAddress: '127.0.0.1',
      port: 8080,
      dbPath: '/data/data.db',
      jwtKeyPath: '/c/jwt-key.pem',
    })
    assertEqual(
      flagValue(withKey, '--auth-jwt-key-file'),
      '/c/jwt-key.pem',
      'key flag with a key',
    )
  })
})
