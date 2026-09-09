/**
 * A tiny in-process RESP2 server for testing the Redis/Valkey migration path.
 *
 * It exists so the copy can be driven against exact protocol behaviour that is
 * awkward to provoke from a real server: a target that refuses every DUMP
 * payload because the RDB version is foreign, a source that does not implement
 * DUMP at all, a peer that answers with bytes that are not RESP, and one that
 * accepts the connection and then never speaks again.
 *
 * Requests are parsed as RESP arrays of bulk strings (which is all a client
 * ever sends). Handlers get the command as strings plus the raw argument
 * Buffers, so binary keys and values can be asserted on exactly.
 */

import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net'

export type FakeRespRequest = {
  // The command name, upper-cased (`SET`, `HSCAN`, ...).
  name: string
  // Every argument after the command name, as raw bytes.
  args: Buffer[]
  // The same arguments decoded as latin1, for readable assertions.
  text: string[]
}

// Return a Buffer to write it verbatim, or nothing to stay silent.
export type FakeRespHandler = (
  request: FakeRespRequest,
  socket: Socket,
) => Buffer | void

export type FakeRespServer = {
  port: number
  // Every request the server received, in order.
  received: FakeRespRequest[]
  close: () => Promise<void>
}

export const respOk = (): Buffer => Buffer.from('+OK\r\n')
export const respPong = (): Buffer => Buffer.from('+PONG\r\n')
export const respError = (message: string): Buffer =>
  Buffer.from(`-${message}\r\n`)
export const respInteger = (value: number): Buffer =>
  Buffer.from(`:${value}\r\n`)
export const respNil = (): Buffer => Buffer.from('$-1\r\n')

export function respBulk(value: string | Buffer): Buffer {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return Buffer.concat([
    Buffer.from(`$${buf.length}\r\n`),
    buf,
    Buffer.from('\r\n'),
  ])
}

export function respArray(items: Array<Buffer>): Buffer {
  return Buffer.concat([Buffer.from(`*${items.length}\r\n`), ...items])
}

// A SCAN/HSCAN/SSCAN/ZSCAN reply: [cursor, [element, ...]].
export function respScan(
  cursor: string,
  items: Array<string | Buffer>,
): Buffer {
  return respArray([respBulk(cursor), respArray(items.map(respBulk))])
}

// Pull as many complete RESP request arrays out of `buf` as it holds. Returns
// the parsed requests plus whatever bytes are left over.
function parseRequests(buf: Buffer): {
  requests: FakeRespRequest[]
  rest: Buffer
} {
  const requests: FakeRespRequest[] = []
  let offset = 0
  for (;;) {
    if (offset >= buf.length || buf[offset] !== 0x2a) break
    const header = readLine(buf, offset)
    if (!header) break
    const count = Number(header.line.slice(1))
    let cursor = header.next
    const args: Buffer[] = []
    let complete = true
    for (let i = 0; i < count; i++) {
      const lengthLine = readLine(buf, cursor)
      if (!lengthLine) {
        complete = false
        break
      }
      const length = Number(lengthLine.line.slice(1))
      const end = lengthLine.next + length
      if (end + 2 > buf.length) {
        complete = false
        break
      }
      // Copied rather than sliced: a view keeps the whole read buffer alive
      // and types as Buffer<ArrayBufferLike>, which the strict build rejects.
      args.push(Buffer.from(buf.subarray(lengthLine.next, end)))
      cursor = end + 2
    }
    if (!complete) break
    const name = (args.shift() ?? Buffer.alloc(0)).toString('latin1')
    requests.push({
      name: name.toUpperCase(),
      args,
      text: args.map((a) => a.toString('latin1')),
    })
    offset = cursor
  }
  // Copied, not sliced, for the same reason as the arguments above.
  return {
    requests,
    rest: offset === 0 ? buf : Buffer.from(buf.subarray(offset)),
  }
}

function readLine(
  buf: Buffer,
  from: number,
): { line: string; next: number } | null {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      return { line: buf.toString('latin1', from, i), next: i + 2 }
    }
  }
  return null
}

export async function startFakeRespServer(
  handler: FakeRespHandler,
): Promise<FakeRespServer> {
  const received: FakeRespRequest[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // A test peer that is torn down mid-command must not crash the run.
    socket.on('error', () => {})
    let leftover = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      const { requests, rest } = parseRequests(Buffer.concat([leftover, chunk]))
      leftover = Buffer.concat([rest])
      for (const request of requests) {
        received.push(request)
        const reply = handler(request, socket)
        if (reply && !socket.destroyed) socket.write(reply)
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/**
 * A handler that answers the connection handshake (AUTH/PING/DBSIZE/SELECT)
 * and delegates everything else. Saves every scenario from repeating it.
 */
export function withHandshake(
  dbsize: number,
  handler: FakeRespHandler,
): FakeRespHandler {
  return (request, socket) => {
    switch (request.name) {
      case 'AUTH':
      case 'SELECT':
        return respOk()
      case 'PING':
        return respPong()
      case 'DBSIZE':
        return respInteger(dbsize)
      default:
        return handler(request, socket)
    }
  }
}
