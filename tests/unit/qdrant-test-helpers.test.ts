import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import { getQdrantPointCount, insertQdrantPoints } from '../integration/helpers'

describe('Qdrant integration helper visibility', () => {
  it('waits for inserts to finish before reading an exact count', async () => {
    let appliedPoints = 0
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const url = new URL(request.url!, 'http://localhost')
      let result: object = { points_count: 0 }
      if (request.method === 'PUT') {
        const completed = url.searchParams.get('wait') === 'true'
        if (completed) appliedPoints = JSON.parse(body).points.length
        result = { status: completed ? 'completed' : 'acknowledged' }
      } else if (
        request.method === 'POST' &&
        url.pathname.endsWith('/points/count') &&
        JSON.parse(body).exact === true
      ) {
        result = { count: appliedPoints }
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ status: 'ok', result }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    try {
      assert.equal(
        await insertQdrantPoints(address.port, 'fixture', [
          { id: 1, vector: [0.1] },
          { id: 2, vector: [0.2] },
          { id: 3, vector: [0.3] },
        ]),
        true,
      )
      assert.equal(appliedPoints, 3, 'acknowledgement alone is not completion')
      assert.equal(await getQdrantPointCount(address.port, 'fixture'), 3)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
