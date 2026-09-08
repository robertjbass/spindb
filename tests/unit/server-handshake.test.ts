import { describe, it } from 'node:test'
import { createServer, type Server, type Socket } from 'net'
import {
  parseMysqlWireHandshake,
  classifyMysqlFamilyServer,
  readMysqlWireServerVersion,
} from '../../core/server-handshake'
import { assert, assertEqual, assertNotEqual } from '../utils/assertions'

/**
 * Build a MySQL-protocol packet: 3-byte little-endian payload length, a
 * sequence id, then the payload.
 */
function packet(payload: Buffer, sequenceId = 0): Buffer {
  const header = Buffer.alloc(4)
  header.writeUIntLE(payload.length, 0, 3)
  header[3] = sequenceId
  return Buffer.concat([header, payload])
}

/**
 * A realistic initial handshake packet: protocol version 10, the NUL
 * terminated server version, then the connection id, scramble, capability
 * flags and so on that the probe never reads.
 */
function handshakePacket(serverVersion: string): Buffer {
  const tail = Buffer.from([
    0x0b,
    0x00,
    0x00,
    0x00, // connection id
    0x51,
    0x2d,
    0x63,
    0x5f,
    0x4a,
    0x1a,
    0x2b,
    0x3e, // auth-plugin-data-part-1
    0x00, // filler
    0xff,
    0xff, // capability flags (lower)
    0xff, // character set
    0x02,
    0x00, // status flags
  ])
  return packet(
    Buffer.concat([
      Buffer.from([0x0a]),
      Buffer.from(`${serverVersion}\0`, 'utf8'),
      tail,
    ]),
  )
}

function errPacket(code: number, message: string, sqlState?: string): Buffer {
  const head = Buffer.alloc(3)
  head[0] = 0xff
  head.writeUInt16LE(code, 1)
  const state = sqlState ? Buffer.from(`#${sqlState}`, 'utf8') : Buffer.alloc(0)
  return packet(Buffer.concat([head, state, Buffer.from(message, 'utf8')]))
}

describe('parseMysqlWireHandshake', () => {
  it('reads the version out of a MySQL greeting', () => {
    const parsed = parseMysqlWireHandshake(handshakePacket('9.7.2'))

    assertEqual(parsed.kind, 'handshake', 'a MySQL greeting should parse')
    assert(parsed.kind === 'handshake', 'narrow the union')
    assertEqual(parsed.serverVersion, '9.7.2', 'server version')
    assertEqual(parsed.protocolVersion, 0x0a, 'protocol version')
  })

  it('reads the version out of a MariaDB greeting', () => {
    const parsed = parseMysqlWireHandshake(handshakePacket('11.8.8-MariaDB'))

    assert(parsed.kind === 'handshake', 'a MariaDB greeting should parse')
    assertEqual(parsed.serverVersion, '11.8.8-MariaDB', 'server version')
  })

  it('reads the version a ProxySQL front end announces', () => {
    // ProxySQL answers the greeting itself, with the version it was
    // configured to advertise rather than the backend's patch level.
    const parsed = parseMysqlWireHandshake(handshakePacket('11.8.0-MariaDB'))

    assert(parsed.kind === 'handshake', 'ProxySQL greeting should parse')
    assertEqual(parsed.serverVersion, '11.8.0-MariaDB', 'server version')
  })

  it('asks for more bytes when the packet is truncated', () => {
    const full = handshakePacket('11.8.8-MariaDB')

    // A greeting can arrive split across several TCP reads, so a short buffer
    // must never be reported as a failure.
    assertEqual(
      parseMysqlWireHandshake(full.subarray(0, 3)).kind,
      'incomplete',
      'a partial header is incomplete',
    )
    assertEqual(
      parseMysqlWireHandshake(full.subarray(0, 8)).kind,
      'incomplete',
      'a partial payload is incomplete',
    )
    assertEqual(
      parseMysqlWireHandshake(full.subarray(0, full.length - 1)).kind,
      'incomplete',
      'one byte short is still incomplete',
    )
    assertEqual(
      parseMysqlWireHandshake(Buffer.alloc(0)).kind,
      'incomplete',
      'an empty buffer is incomplete',
    )
  })

  it('reports an ERR packet sent instead of a greeting', () => {
    const parsed = parseMysqlWireHandshake(
      errPacket(
        1129,
        "Host '10.0.0.9' is blocked because of many connection errors",
      ),
    )

    assert(parsed.kind === 'error', 'an ERR packet is not a greeting')
    assertEqual(parsed.errorCode, 1129, 'error code')
    assert(
      parsed.message.startsWith("Host '10.0.0.9' is blocked"),
      `error message should survive, got: ${parsed.message}`,
    )
  })

  it('strips the SQL state marker from an ERR packet that carries one', () => {
    const parsed = parseMysqlWireHandshake(
      errPacket(1045, 'Access denied for user', 'HY000'),
    )

    assert(parsed.kind === 'error', 'an ERR packet is not a greeting')
    assertEqual(parsed.message, 'Access denied for user', 'message only')
  })

  it('refuses a packet that is not the MySQL wire protocol', () => {
    const parsed = parseMysqlWireHandshake(
      packet(Buffer.from([0x52, 0x00, 0x00, 0x00])),
    )

    assert(parsed.kind === 'error', 'a foreign protocol is an error')
    assertEqual(parsed.errorCode, null, 'no MySQL error code to report')
  })
})

describe('classifyMysqlFamilyServer', () => {
  it('classifies a MySQL server', () => {
    const server = classifyMysqlFamilyServer('9.7.2')

    assertEqual(server.flavor, 'mysql', 'flavor')
    assertEqual(server.version, '9.7.2', 'version')
    assertEqual(server.majorVersion, 9, 'major')
    assertEqual(server.minorVersion, 7, 'minor')
  })

  it('classifies a MariaDB 11 server', () => {
    const server = classifyMysqlFamilyServer('11.8.8-MariaDB')

    assertEqual(server.flavor, 'mariadb', 'flavor')
    assertEqual(server.majorVersion, 11, 'major')
    assertEqual(server.minorVersion, 8, 'minor')
  })

  it('sees through the 5.5.5 replication prefix MariaDB 10 announces', () => {
    // Without stripping this, every MariaDB 10 server reads as MySQL 5.5 and
    // gets dumped with the wrong tool.
    const server = classifyMysqlFamilyServer('5.5.5-10.11.15-MariaDB')

    assertEqual(server.flavor, 'mariadb', 'flavor')
    assertEqual(server.version, '10.11.15-MariaDB', 'prefix stripped')
    assertEqual(server.majorVersion, 10, 'major')
    assertEqual(server.rawVersion, '5.5.5-10.11.15-MariaDB', 'raw kept')
  })

  it('treats a MySQL rebuild as MySQL', () => {
    // Percona, RDS and friends take the same mysqldump.
    assertEqual(
      classifyMysqlFamilyServer('8.0.36-28').flavor,
      'mysql',
      'a vendor build is still MySQL',
    )
  })

  it('reports an unrecognizable version as unknown', () => {
    const server = classifyMysqlFamilyServer('some-proxy')

    assertEqual(server.flavor, 'unknown', 'flavor')
    assertEqual(server.majorVersion, null, 'no major version')
    assertNotEqual(server.flavor, 'mariadb', 'never guess MariaDB')
  })
})

/**
 * Serve one greeting on an ephemeral port. `onConnection` decides what the
 * fake server does, so the socket path is exercised without a real database.
 */
async function withFakeServer(
  onConnection: (socket: Socket) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(onConnection)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  try {
    await run(port)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('readMysqlWireServerVersion', () => {
  it('reads a greeting that arrives in two chunks, without writing anything', async () => {
    const greeting = handshakePacket('11.8.8-MariaDB')
    let bytesFromClient = 0

    await withFakeServer(
      (socket) => {
        socket.on('data', (chunk: Buffer) => {
          bytesFromClient += chunk.length
        })
        socket.write(greeting.subarray(0, 6))
        setTimeout(() => socket.write(greeting.subarray(6)), 10)
      },
      async (port) => {
        const version = await readMysqlWireServerVersion({
          host: '127.0.0.1',
          port,
        })
        assertEqual(version, '11.8.8-MariaDB', 'version read from the wire')
      },
    )

    // TLS is negotiated in the client's REPLY, so a probe that never writes
    // works against a TLS-required server too. This asserts we stay silent.
    assertEqual(bytesFromClient, 0, 'the probe must not send anything')
  })

  it('fails when the server closes without a greeting', async () => {
    await withFakeServer(
      (socket) => socket.destroy(),
      async (port) => {
        let failed = false
        try {
          await readMysqlWireServerVersion({ host: '127.0.0.1', port })
        } catch {
          failed = true
        }
        assert(failed, 'a closed connection must reject')
      },
    )
  })

  it('fails when the server answers with an ERR packet', async () => {
    await withFakeServer(
      (socket) => socket.write(errPacket(1129, 'Host is blocked')),
      async (port) => {
        let message = ''
        try {
          await readMysqlWireServerVersion({ host: '127.0.0.1', port })
        } catch (error) {
          message = (error as Error).message
        }
        assert(
          message.includes('Host is blocked'),
          `the server message should surface, got: ${message}`,
        )
      },
    )
  })

  it('gives up on a server that never speaks', async () => {
    await withFakeServer(
      () => {
        // Accept and say nothing.
      },
      async (port) => {
        let message = ''
        try {
          await readMysqlWireServerVersion({
            host: '127.0.0.1',
            port,
            timeoutMs: 150,
          })
        } catch (error) {
          message = (error as Error).message
        }
        assert(
          message.includes('Timed out'),
          `a silent server should time out, got: ${message}`,
        )
      },
    )
  })
})
