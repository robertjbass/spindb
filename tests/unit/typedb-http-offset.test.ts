/**
 * Unit tests for the configurable TypeDB HTTP-port offset.
 *
 * TypeDB's HTTP API listens on the gRPC (main) port plus an offset. The
 * default is 6271, so the stock 1729 gRPC maps to TypeDB's default 8000
 * HTTP. Layerbase cloud overrides it via SPINDB_TYPEDB_HTTP_OFFSET to a
 * small in-block value so the HTTP port can be published to the host
 * alongside gRPC. These tests lock in the default, the override, and the
 * invalid-value fallback so config.yml generation, the start-time port
 * check, the status probe, and the HTTP query client stay consistent.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TYPEDB_HTTP_OFFSET,
  typedbHttpOffset,
  typedbHttpPort,
  parseTypedbHttpOffsetFromConfig,
} from '../../engines/typedb/cli-utils'

// Minimal config.yml shaped like the one initDataDir writes: the gRPC
// `server.address` first, then the `http.address`. `host`/`port` fields
// for admin + monitoring must NOT be picked up (only `address:` lines).
function configYml(grpc: number, http: number, ip = '127.0.0.1'): string {
  return [
    'server:',
    `  address: ${ip}:${grpc}`,
    '  http:',
    '    enabled: true',
    `    address: ${ip}:${http}`,
    '  admin:',
    '    enabled: true',
    `    port: ${grpc + 6372}`,
    'diagnostics:',
    '  monitoring:',
    '    enabled: false',
    '    port: 4104',
  ].join('\n')
}

const ENV_KEY = 'SPINDB_TYPEDB_HTTP_OFFSET'

describe('typedb HTTP-port offset', () => {
  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  it('defaults to 6271 (1729 gRPC -> 8000 HTTP) when unset', () => {
    delete process.env[ENV_KEY]
    assert.equal(DEFAULT_TYPEDB_HTTP_OFFSET, 6271)
    assert.equal(typedbHttpOffset(), 6271)
    assert.equal(typedbHttpPort(1729), 8000)
    assert.equal(typedbHttpPort(40000), 46271)
  })

  it('honors a positive-integer override', () => {
    process.env[ENV_KEY] = '1'
    assert.equal(typedbHttpOffset(), 1)
    assert.equal(typedbHttpPort(1729), 1730)
    assert.equal(typedbHttpPort(40000), 40001)
  })

  it('falls back to the default for non-positive or non-numeric values', () => {
    for (const bad of ['0', '-5', 'abc', '', '   ']) {
      process.env[ENV_KEY] = bad
      assert.equal(
        typedbHttpOffset(),
        6271,
        `expected fallback for ${JSON.stringify(bad)}`,
      )
    }
  })
})

describe('parseTypedbHttpOffsetFromConfig (per-container persistence)', () => {
  it('recovers the default 6271 offset from a stock config', () => {
    assert.equal(parseTypedbHttpOffsetFromConfig(configYml(1729, 8000)), 6271)
  })

  it('recovers a small in-block offset (cloud scheme)', () => {
    assert.equal(parseTypedbHttpOffsetFromConfig(configYml(47000, 47001)), 1)
  })

  it('parses 0.0.0.0 addresses (after the cloud bind-address rewrite)', () => {
    assert.equal(
      parseTypedbHttpOffsetFromConfig(configYml(47000, 47001, '0.0.0.0')),
      1,
    )
  })

  it('ignores admin/monitoring port lines (only address: lines count)', () => {
    // admin port is grpc+6372 and monitoring is 4104; if either were picked
    // up as the "http" port the offset would be wrong.
    assert.equal(parseTypedbHttpOffsetFromConfig(configYml(2000, 2001)), 1)
  })

  it('returns null for unparseable/empty config so callers use the default', () => {
    assert.equal(parseTypedbHttpOffsetFromConfig(''), null)
    assert.equal(parseTypedbHttpOffsetFromConfig('server:\n  foo: bar'), null)
    // http <= grpc is nonsensical (never written by initDataDir) -> null
    assert.equal(parseTypedbHttpOffsetFromConfig(configYml(8000, 8000)), null)
  })
})
