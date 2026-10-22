import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPostgresConfig,
  buildGatewayConfig,
  buildPeerAuthentication,
} from '../../engines/documentdb/runtime-config'

describe('DocumentDB private backend configuration', () => {
  it('disables TCP and limits peer identities to the owning OS user', () => {
    const config = buildPostgresConfig({
      socketDirectory: '/tmp/docdb/socket',
      port: 5432,
    })
    assert.match(config, /listen_addresses = ''/)
    assert.match(config, /unix_socket_permissions = 0700/)
    assert.match(config, /cron.launch_active_jobs = off/)
    assert.match(config, /pg_documentdb_extended_rum/)
    assert.match(config, /documentdb.localhost_connection_string = 'host=/)
    const { hba, ident } = buildPeerAuthentication('ubuntu')
    assert.equal(hba, 'local all all peer map=spindb_documentdb\n')
    assert.match(ident, /spindb_documentdb ubuntu spindb_gateway\n/)
    assert.doesNotMatch(hba, /trust|host/)
    assert.throws(
      () => buildPeerAuthentication('ubuntu\nother postgres'),
      /Unsupported OS/,
    )
  })

  it('rejects invalid ports and socket paths before starting a process', () => {
    for (const port of [0, -1, 65536, 1.5, NaN]) {
      assert.throws(
        () => buildPostgresConfig({ socketDirectory: '/tmp/s', port }),
        /Invalid/,
      )
    }
    assert.throws(
      () => buildPostgresConfig({ socketDirectory: 'relative', port: 5432 }),
      /absolute/,
    )
    assert.throws(
      () =>
        buildPostgresConfig({
          socketDirectory: '/' + 'a'.repeat(100),
          port: 5432,
        }),
      /too long/,
    )
    assert.throws(
      () => buildPostgresConfig({ socketDirectory: '/tmp/a\nb', port: 5432 }),
      /control/,
    )
    assert.match(
      buildPostgresConfig({
        socketDirectory: "/tmp/user's socket",
        port: 5432,
      }),
      /user''s socket/,
    )
  })

  it('keeps client and backend authentication separate with telemetry disabled', () => {
    const config = buildGatewayConfig({
      socketDirectory: '/tmp/s',
      backendPort: 5432,
      port: 27019,
    })
    assert.equal(config.PostgresHostName, '/tmp/s')
    assert.equal(config.PostgresDataUserPassword, undefined)
    assert.equal(config.UseLocalHost, true)
    assert.deepEqual(config.TelemetryOptions, {
      ServiceName: 'documentdb_gateway',
      Metrics: { Enabled: false },
      Tracing: { Enabled: false },
    })
    assert.throws(
      () =>
        buildGatewayConfig({
          socketDirectory: '/tmp/s',
          backendPort: 5432,
          port: 27019,
          bindAddress: '192.0.2.1',
        }),
      /127.0.0.1/,
    )
  })
})

it('permits explicit external gateway binding without exposing PostgreSQL', () => {
  const config = buildGatewayConfig({
    socketDirectory: '/tmp/s',
    backendPort: 5432,
    port: 27019,
    bindAddress: '0.0.0.0',
  })
  assert.equal(config.UseLocalHost, false)
  assert.equal(config.PostgresHostName, '/tmp/s')
  assert.equal(config.EnforceTls, false)
  assert.equal(
    buildGatewayConfig({
      socketDirectory: '/tmp/s',
      backendPort: 5432,
      port: 27019,
      bindAddress: '127.0.0.1',
    }).UseLocalHost,
    true,
  )
})
