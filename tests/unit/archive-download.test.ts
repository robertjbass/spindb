import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadArchiveToFile } from '../../core/archive-download'

type Behavior = (response: ServerResponse) => void

async function startServer(
  behaviors: Behavior[],
): Promise<{ url: string; requests: () => number; server: Server }> {
  let count = 0
  const server = createServer((_request, response) => {
    const behavior = behaviors[Math.min(count, behaviors.length - 1)]
    count++
    behavior(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}/archive.tar.gz`,
    requests: () => count,
    server,
  }
}

function stallAfterPartialBody(response: ServerResponse): void {
  response.writeHead(200, { 'content-length': '100' })
  response.write('partial')
}

function sendComplete(response: ServerResponse): void {
  response.writeHead(200, { 'content-length': '8' })
  response.end('complete')
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('downloadArchiveToFile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'archive-download-'))
  after(() => rmSync(directory, { recursive: true, force: true }))

  test('retries a download whose body stalls and keeps the fresh archive', async () => {
    const { url, requests, server } = await startServer([
      stallAfterPartialBody,
      sendComplete,
    ])
    const destination = join(directory, 'retry.tar.gz')
    const messages: string[] = []
    try {
      await downloadArchiveToFile({
        url,
        destination,
        displayName: 'Fixture',
        createNotFoundError: () => new Error('not found'),
        onProgress: (progress) => messages.push(progress.message),
        stallTimeoutMs: 200,
        retryDelaysMs: [0, 0, 0],
      })
    } finally {
      await closeServer(server)
    }
    assert.equal(requests(), 2)
    assert.equal(readFileSync(destination, 'utf8'), 'complete')
    assert.ok(messages.some((message) => /stalled, retrying/.test(message)))
  })

  test('gives up with a stall error after every attempt stalls', async () => {
    const { url, requests, server } = await startServer([stallAfterPartialBody])
    try {
      await assert.rejects(
        downloadArchiveToFile({
          url,
          destination: join(directory, 'stalled.tar.gz'),
          displayName: 'Fixture',
          createNotFoundError: () => new Error('not found'),
          stallTimeoutMs: 200,
          retryDelaysMs: [0, 0],
        }),
        /stalled \(no data for 0.2s\) on all 2 attempts/,
      )
    } finally {
      await closeServer(server)
    }
    assert.equal(requests(), 2)
  })

  test('does not retry a 404 and throws the not-found error', async () => {
    const { url, requests, server } = await startServer([
      (response) => {
        response.writeHead(404)
        response.end()
      },
    ])
    try {
      await assert.rejects(
        downloadArchiveToFile({
          url,
          destination: join(directory, 'missing.tar.gz'),
          displayName: 'Fixture',
          createNotFoundError: () => new Error('fixture version not found'),
          stallTimeoutMs: 200,
          retryDelaysMs: [0, 0, 0],
        }),
        /fixture version not found/,
      )
    } finally {
      await closeServer(server)
    }
    assert.equal(requests(), 1)
  })

  test('the overall timeout is final even while bytes keep arriving', async () => {
    const { url, requests, server } = await startServer([
      (response) => {
        response.writeHead(200, { 'content-length': '1000' })
        const interval = setInterval(() => response.write('x'), 20)
        response.on('close', () => clearInterval(interval))
      },
    ])
    try {
      await assert.rejects(
        downloadArchiveToFile({
          url,
          destination: join(directory, 'slow.tar.gz'),
          displayName: 'Fixture',
          createNotFoundError: () => new Error('not found'),
          stallTimeoutMs: 200,
          totalTimeoutMs: 300,
          retryDelaysMs: [0, 0, 0],
        }),
        /Download timed out/,
      )
    } finally {
      await closeServer(server)
    }
    assert.equal(requests(), 1)
  })
})
