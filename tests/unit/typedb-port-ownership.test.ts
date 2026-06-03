/**
 * Regression test for the TypeDB foreign-server hijack.
 *
 * Bug: spindb's TypeDB engine identified "the server" purely by port + an
 * HTTP `/health` probe. If a different TypeDB process already held the port
 * (e.g. a developer's own TypeDB on the default 1729 / HTTP 8000), spindb's
 * health check saw it as "ready" and the bundled console then talked to that
 * foreign server. With spindb on 3.8.0 (network protocol 7) and the foreign
 * server on 3.11.x (protocol 8), every operation failed with an opaque
 * "incompatible driver version" error.
 *
 * Fix: readiness/status now also read GET /v1/version and require it to match
 * the container's expected version, so a foreign server is detected instead of
 * silently used. This test drives the public status() against a stub HTTP
 * listener (no real TypeDB) standing in for whatever is bound to the port.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { Engine, type ContainerConfig } from '../../types/index'
import { typedbEngine } from '../../engines/typedb/index'

// status() probes http://127.0.0.1:<port + 6271>; mirror that offset so a
// listener on `httpPort` maps back to a container `port`.
const HTTP_OFFSET = 6271

type Stub = { httpPort: number; server: Server }

// Start a stub that answers /health 200 and /v1/version with `reportedVersion`
// (or 404 on /v1/version when null, to simulate a server lacking the endpoint).
function startStub(reportedVersion: string | null): Promise<Stub> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
        return
      }
      if (req.url === '/v1/version') {
        if (reportedVersion === null) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            distribution: 'TypeDB CE',
            version: reportedVersion,
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve({ httpPort: address.port, server })
      } else {
        reject(new Error('No address bound'))
      }
    })
  })
}

function closeStub(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function containerForHttpPort(
  httpPort: number,
  version: string,
): ContainerConfig {
  return {
    name: 'typedb-ownership-test',
    engine: Engine.TypeDB,
    version,
    port: httpPort - HTTP_OFFSET,
    database: 'test',
    created: '2026-01-01T00:00:00.000Z',
    status: 'running',
  }
}

describe('TypeDB status() server-identity guard', () => {
  let foreign: Stub
  let own: Stub
  let healthOnly: Stub

  before(async () => {
    foreign = await startStub('3.11.5')
    own = await startStub('3.8.0')
    healthOnly = await startStub(null)
  })

  after(async () => {
    await closeStub(foreign.server)
    await closeStub(own.server)
    await closeStub(healthOnly.server)
  })

  it('reports not-running when a different TypeDB version holds the port', async () => {
    const status = await typedbEngine.status(
      containerForHttpPort(foreign.httpPort, '3.8.0'),
    )
    assert.equal(status.running, false)
    assert.match(status.message ?? '', /different TypeDB version/i)
    assert.match(status.message ?? '', /3\.11\.5/)
  })

  it('reports running when the version on the port matches', async () => {
    const status = await typedbEngine.status(
      containerForHttpPort(own.httpPort, '3.8.0'),
    )
    assert.equal(status.running, true)
  })

  it('does not false-fail when the server lacks /v1/version (health only)', async () => {
    const status = await typedbEngine.status(
      containerForHttpPort(healthOnly.httpPort, '3.8.0'),
    )
    assert.equal(status.running, true)
  })
})
