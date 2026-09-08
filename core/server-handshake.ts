/**
 * Server Handshake Probing
 *
 * Engine-agnostic: reads the greeting a database server sends the moment a TCP
 * connection is opened, before any credentials are exchanged, so spindb can
 * pick the client tool that matches the SERVER it is about to talk to.
 *
 * This is the same principle PostgreSQL already follows in
 * `engines/postgresql/version-validator.ts`: the tool that takes a remote dump
 * follows the SOURCE server, not the target container. PostgreSQL only has to
 * follow a version, because there is one `pg_dump`. The MySQL family has two
 * incompatible client families, so it has to follow a flavor as well as a
 * version, and the flavor is not in the connection string: a MariaDB server
 * and a MySQL server are both reached through `mysql://`.
 *
 * Reading the greeting is the only way to tell them apart without a successful
 * login. We never write to the socket:
 * - MySQL and MariaDB both send the initial handshake packet unprompted, and
 *   TLS is negotiated in the client's REPLY, so a plain read works even against
 *   a server that requires TLS.
 * - No credentials are sent, so a probe cannot fail authentication, and a
 *   caller with a wrong password still learns the flavor.
 */

import { Socket } from 'net'
import { logDebug } from './error-handler'

const HEADER_BYTES = 4
const HANDSHAKE_PROTOCOL_V10 = 0x0a
const ERR_PACKET_HEADER = 0xff
const SQLSTATE_MARKER = 0x23 // '#'
const SQLSTATE_BYTES = 6 // marker + 5 characters
const DEFAULT_TIMEOUT_MS = 5000

/**
 * The result of parsing whatever bytes have arrived so far.
 *
 * `incomplete` means "call me again with more bytes", NOT "this failed" - a
 * greeting can be split across several TCP reads.
 */
export type MysqlWireHandshake =
  | { kind: 'handshake'; protocolVersion: number; serverVersion: string }
  | { kind: 'error'; errorCode: number | null; message: string }
  | { kind: 'incomplete' }

/**
 * Parse a MySQL-protocol initial handshake packet.
 *
 * Pure, so the packet shapes are unit tested against fixture bytes rather than
 * against a running server.
 *
 * Packet layout (both MySQL and MariaDB):
 *   bytes 0-2   payload length, little endian
 *   byte  3     sequence id
 *   byte  4     protocol version (0x0a), or 0xff for an ERR packet
 *   bytes 5..   NUL-terminated server version string
 *
 * A server that refuses the connection outright (host blocked, too many
 * connections, TLS-only proxies) answers with an ERR packet INSTEAD of a
 * greeting, which is why that is a parse outcome and not an exception.
 */
export function parseMysqlWireHandshake(buffer: Buffer): MysqlWireHandshake {
  if (buffer.length < HEADER_BYTES + 1) {
    return { kind: 'incomplete' }
  }

  const payloadLength = buffer.readUIntLE(0, 3)
  if (buffer.length < HEADER_BYTES + payloadLength) {
    return { kind: 'incomplete' }
  }

  const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + payloadLength)

  // A header that declares a zero-length payload carries no protocol byte, so
  // every read below would be `undefined`. Classify it before touching
  // `payload[0]`: the packet is already complete, so asking for more bytes
  // would only stall until the timeout.
  if (payload.length === 0) {
    return {
      kind: 'error',
      errorCode: null,
      message:
        'Server sent an empty packet instead of a greeting. ' +
        'This does not look like a MySQL-protocol server.',
    }
  }

  if (payload[0] === ERR_PACKET_HEADER) {
    return parseErrPacket(payload)
  }

  if (payload[0] !== HANDSHAKE_PROTOCOL_V10) {
    return {
      kind: 'error',
      errorCode: null,
      message:
        `Unexpected handshake protocol version 0x${payload[0].toString(16)} ` +
        '(expected 0x0a). This does not look like a MySQL-protocol server.',
    }
  }

  const terminator = payload.indexOf(0x00, 1)
  if (terminator === -1) {
    return { kind: 'incomplete' }
  }

  return {
    kind: 'handshake',
    protocolVersion: payload[0],
    serverVersion: payload.toString('utf8', 1, terminator),
  }
}

function parseErrPacket(payload: Buffer): MysqlWireHandshake {
  if (payload.length < 3) {
    return {
      kind: 'error',
      errorCode: null,
      message: 'Server rejected the connection without a message',
    }
  }

  const errorCode = payload.readUInt16LE(1)
  // A connection-phase ERR packet usually carries no SQL state, but a server
  // that has already negotiated CLIENT_PROTOCOL_41 prefixes one as "#HY000".
  const hasSqlState = payload[3] === SQLSTATE_MARKER
  const messageStart = hasSqlState ? 3 + SQLSTATE_BYTES : 3

  return {
    kind: 'error',
    errorCode,
    message: payload.toString('utf8', messageStart).trim(),
  }
}

/**
 * Open a TCP connection, read the server's greeting, and return the version
 * string it announces (for example `9.7.2`, `11.8.8-MariaDB`, or
 * `11.8.0-MariaDB` from a ProxySQL front end).
 *
 * Nothing is ever written to the socket, and the socket is destroyed as soon
 * as the version is known.
 *
 * @throws when the server cannot be reached, refuses the connection, or does
 *   not speak the MySQL wire protocol. Callers that only want a best-effort
 *   hint should catch and fall back.
 */
export async function readMysqlWireServerVersion(options: {
  host: string
  port: number
  timeoutMs?: number
}): Promise<string> {
  const { host, port, timeoutMs = DEFAULT_TIMEOUT_MS } = options

  return new Promise<string>((resolve, reject) => {
    const socket = new Socket()
    let buffer = Buffer.alloc(0)
    let settled = false

    const finish = (error: Error | null, version?: string) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) {
        reject(error)
      } else {
        resolve(version!)
      }
    }

    socket.setTimeout(timeoutMs)

    socket.on('timeout', () => {
      finish(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for a greeting from ${host}:${port}`,
        ),
      )
    })

    socket.on('error', (error: Error) => {
      finish(new Error(`Could not reach ${host}:${port}: ${error.message}`))
    })

    socket.on('close', () => {
      finish(
        new Error(
          `${host}:${port} closed the connection before sending a greeting`,
        ),
      )
    })

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])

      // A throw in here is an uncaught exception on the socket, not a rejected
      // promise, so it would take the whole process down instead of reaching
      // the caller's catch. The probe is best-effort: a parser it cannot trust
      // must still end as a rejected read.
      let parsed: MysqlWireHandshake
      try {
        parsed = parseMysqlWireHandshake(buffer)
      } catch (error) {
        finish(
          new Error(
            `Could not read the greeting from ${host}:${port}: ` +
              (error instanceof Error ? error.message : String(error)),
          ),
        )
        return
      }

      if (parsed.kind === 'incomplete') return

      if (parsed.kind === 'error') {
        finish(
          new Error(
            `${host}:${port} refused the connection: ${parsed.message}`,
          ),
        )
        return
      }

      logDebug('Read MySQL wire server version', {
        host,
        port,
        serverVersion: parsed.serverVersion,
      })
      finish(null, parsed.serverVersion)
    })

    socket.connect(port, host)
  })
}

export type MysqlFamilyFlavor = 'mariadb' | 'mysql' | 'unknown'

export type MysqlFamilyServer = {
  flavor: MysqlFamilyFlavor
  /** Version with MariaDB's replication-compatibility prefix removed. */
  version: string
  /** Exactly what the server announced. */
  rawVersion: string
  majorVersion: number | null
  minorVersion: number | null
}

/**
 * Classify a MySQL-protocol version string into a flavor.
 *
 * MariaDB 10.x announces itself as `5.5.5-10.11.15-MariaDB`: the `5.5.5-`
 * prefix is a compatibility lie for old replication clients, dropped in
 * MariaDB 11. Strip it before reading the version, or every MariaDB 10 server
 * looks like MySQL 5.5.
 *
 * Anything that starts with a number but never says MariaDB is treated as
 * MySQL, which is what a Percona or an AWS build wants: they take the same
 * mysqldump.
 */
export function classifyMysqlFamilyServer(version: string): MysqlFamilyServer {
  const rawVersion = version.trim()
  const stripped = rawVersion.replace(/^5\.5\.5-/, '')
  const numeric = stripped.match(/^(\d+)\.(\d+)/)

  let flavor: MysqlFamilyFlavor = 'unknown'
  if (/mariadb/i.test(stripped)) {
    flavor = 'mariadb'
  } else if (numeric) {
    flavor = 'mysql'
  }

  return {
    flavor,
    version: stripped,
    rawVersion,
    majorVersion: numeric ? parseInt(numeric[1], 10) : null,
    minorVersion: numeric ? parseInt(numeric[2], 10) : null,
  }
}

/**
 * Best-effort flavor probe: never throws.
 *
 * A source that cannot be probed is reported as `unknown`, which every caller
 * treats as "keep doing what you did before". A probe failure must never be
 * the reason a dump does not happen - the dump tool itself reports a real
 * connection problem far better than a greeting read can.
 */
export async function probeMysqlFamilyServer(options: {
  host: string
  port: number
  timeoutMs?: number
}): Promise<MysqlFamilyServer> {
  try {
    const version = await readMysqlWireServerVersion(options)
    return classifyMysqlFamilyServer(version)
  } catch (error) {
    logDebug('MySQL family server probe failed', {
      host: options.host,
      port: options.port,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      flavor: 'unknown',
      version: '',
      rawVersion: '',
      majorVersion: null,
      minorVersion: null,
    }
  }
}
