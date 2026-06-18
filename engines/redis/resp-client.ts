// Minimal, dependency-free RESP2 client for the one job spindb's external CLI
// tools cannot do: a binary-safe `SCAN` + `DUMP`/`PTTL` -> `RESTORE` copy
// between a remote Redis/Valkey (including Upstash over `rediss://`) and a
// target. `redis-cli` mangles binary `DUMP` payloads in text mode, and the
// `--rdb`/`BGSAVE` full-snapshot shortcut is blocked on Upstash and most
// managed Redis - so for the migration path we speak RESP directly over a
// socket. Scope is deliberately tiny: AUTH, SELECT, PING, DBSIZE, SCAN, DUMP,
// PTTL, RESTORE, plus pipelining. Keys and payloads are Buffers end to end, so
// binary values and binary keys round-trip exactly.

import { type Socket, connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

// A parsed RESP reply. Bulk strings are Buffers (binary-safe); a `-ERR` reply
// is surfaced as an Error so the caller's awaited command rejects.
export type RespReply = Buffer | number | string | null | Error | RespReply[]

const CR = 0x0d
const LF = 0x0a

// Encode a command as a RESP array of bulk strings. Each argument may be a
// string (UTF-8) or a Buffer (raw bytes - used for binary keys + DUMP payloads).
function encodeCommand(args: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)]
  for (const arg of args) {
    const buf = Buffer.isBuffer(arg) ? arg : Buffer.from(arg)
    parts.push(Buffer.from(`$${buf.length}\r\n`), buf, Buffer.from('\r\n'))
  }
  return Buffer.concat(parts)
}

// Find the index just past the next CRLF at or after `from`, or -1 if the
// buffer does not yet contain a complete line.
function indexAfterCrlf(buf: Buffer, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i + 2
  }
  return -1
}

// Parse one RESP reply starting at `offset`. Returns the value + the offset
// just past it, or null when the buffer does not yet hold a complete reply
// (the caller waits for more bytes and retries). Binary-safe: bulk strings are
// sliced by their length prefix, never by scanning for delimiters.
function parseReply(
  buf: Buffer,
  offset: number,
): { value: RespReply; offset: number } | null {
  if (offset >= buf.length) return null
  const type = buf[offset]
  const lineEnd = indexAfterCrlf(buf, offset + 1)
  if (lineEnd === -1) return null
  const line = buf.toString('latin1', offset + 1, lineEnd - 2)

  switch (type) {
    case 0x2b: // '+' simple string
      return { value: line, offset: lineEnd }
    case 0x2d: // '-' error
      return { value: new Error(line), offset: lineEnd }
    case 0x3a: // ':' integer
      return { value: Number(line), offset: lineEnd }
    case 0x24: {
      // '$' bulk string
      const len = Number(line)
      if (len === -1) return { value: null, offset: lineEnd }
      const end = lineEnd + len
      if (end + 2 > buf.length) return null // value + trailing CRLF not in yet
      return { value: buf.subarray(lineEnd, end), offset: end + 2 }
    }
    case 0x2a: {
      // '*' array
      const count = Number(line)
      if (count === -1) return { value: null, offset: lineEnd }
      const items: RespReply[] = []
      let cur = lineEnd
      for (let i = 0; i < count; i++) {
        const parsed = parseReply(buf, cur)
        if (!parsed) return null
        items.push(parsed.value)
        cur = parsed.offset
      }
      return { value: items, offset: cur }
    }
    default:
      throw new Error(`Unsupported RESP reply type: ${String.fromCharCode(type)}`)
  }
}

export type RespConnectOptions = {
  host: string
  port: number
  tls: boolean
  username?: string
  password?: string
  database?: number
  // rediss:// across providers presents varied cert chains; default to not
  // verifying (we are reading from a host the user explicitly named). Set true
  // to enforce verification.
  rejectUnauthorized?: boolean
  connectTimeoutMs?: number
}

export class RespClient {
  private socket: Socket
  private inbox: Buffer = Buffer.alloc(0)
  // FIFO of resolvers, one per in-flight command (pipelining-friendly).
  private queue: Array<{
    resolve: (value: RespReply) => void
    reject: (err: Error) => void
  }> = []
  private fatal: Error | null = null

  private constructor(socket: Socket) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (err: Error) => this.onFatal(err))
    socket.on('close', () =>
      this.onFatal(new Error('Redis connection closed')),
    )
  }

  private onData(chunk: Buffer): void {
    this.inbox = this.inbox.length === 0 ? chunk : Buffer.concat([this.inbox, chunk])
    let offset = 0
    for (;;) {
      const parsed = parseReply(this.inbox, offset)
      if (!parsed) break
      offset = parsed.offset
      const waiter = this.queue.shift()
      if (!waiter) continue // unexpected push (e.g. server-side); ignore
      if (parsed.value instanceof Error) waiter.reject(parsed.value)
      else waiter.resolve(parsed.value)
    }
    this.inbox = offset === 0 ? this.inbox : this.inbox.subarray(offset)
  }

  private onFatal(err: Error): void {
    if (this.fatal) return
    this.fatal = err
    for (const waiter of this.queue) waiter.reject(err)
    this.queue = []
  }

  // Send one command and await its reply.
  command(args: Array<string | Buffer>): Promise<RespReply> {
    if (this.fatal) return Promise.reject(this.fatal)
    const promise = new Promise<RespReply>((resolve, reject) => {
      this.queue.push({ resolve, reject })
    })
    this.socket.write(encodeCommand(args))
    return promise
  }

  // Send a batch of commands in one write and await all replies in order. This
  // is the throughput lever: dump N keys (DUMP+PTTL) or restore N keys per
  // round-trip instead of one command at a time.
  pipeline(commands: Array<Array<string | Buffer>>): Promise<RespReply[]> {
    if (this.fatal) return Promise.reject(this.fatal)
    const promises = commands.map(
      () =>
        new Promise<RespReply>((resolve, reject) => {
          this.queue.push({ resolve, reject })
        }),
    )
    this.socket.write(Buffer.concat(commands.map(encodeCommand)))
    return Promise.all(promises)
  }

  close(): void {
    this.socket.destroy()
  }

  static async connect(opts: RespConnectOptions): Promise<RespClient> {
    const socket: Socket = await new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      const timeoutMs = opts.connectTimeoutMs ?? 15000
      const s = opts.tls
        ? tlsConnect({
            host: opts.host,
            port: opts.port,
            servername: opts.host,
            rejectUnauthorized: opts.rejectUnauthorized ?? false,
          })
        : netConnect({ host: opts.host, port: opts.port })
      const onReady = () => {
        s.removeListener('error', onError)
        s.setTimeout(0)
        resolve(s)
      }
      s.setTimeout(timeoutMs, () => {
        s.destroy()
        reject(new Error(`Redis connection timed out after ${timeoutMs}ms`))
      })
      s.once('error', onError)
      s.once(opts.tls ? 'secureConnect' : 'connect', onReady)
    })

    const client = new RespClient(socket)
    if (opts.password) {
      const authArgs =
        opts.username && opts.username !== 'default'
          ? ['AUTH', opts.username, opts.password]
          : ['AUTH', opts.password]
      await client.command(authArgs)
    }
    if (opts.database && opts.database > 0) {
      await client.command(['SELECT', String(opts.database)])
    }
    return client
  }

  // ─── Typed helpers for the migration ops ──────────────────────────

  async ping(): Promise<void> {
    await this.command(['PING'])
  }

  async dbsize(): Promise<number> {
    const reply = await this.command(['DBSIZE'])
    return typeof reply === 'number' ? reply : 0
  }

  // One SCAN step. Returns the next cursor ('0' when complete) and the batch of
  // keys as Buffers (binary-safe).
  async scan(cursor: string, count: number): Promise<{
    cursor: string
    keys: Buffer[]
  }> {
    const reply = await this.command(['SCAN', cursor, 'COUNT', String(count)])
    if (!Array.isArray(reply) || reply.length < 2) {
      throw new Error('Unexpected SCAN reply')
    }
    const nextCursor = Buffer.isBuffer(reply[0])
      ? reply[0].toString('latin1')
      : String(reply[0])
    const keysField = reply[1]
    const keys = Array.isArray(keysField)
      ? keysField.filter((k): k is Buffer => Buffer.isBuffer(k))
      : []
    return { cursor: nextCursor, keys }
  }
}

export type RedisCopyProgress = {
  scanned: number
  restored: number
  total: number
}

// Binary-safe keyspace copy: SCAN the source, pipeline DUMP+PTTL per batch, and
// RESTORE (with TTL, REPLACE) into the target. Preserves every type and TTL
// exactly because DUMP/RESTORE moves Redis's own serialization. Used by the
// `restore --from-url` path for redis/valkey. Returns the number of keys copied.
export async function copyRedisKeyspace(
  source: RespConnectOptions,
  target: RespConnectOptions,
  options: {
    batchSize?: number
    onProgress?: (progress: RedisCopyProgress) => void
  } = {},
): Promise<{ keysCopied: number; total: number }> {
  const batchSize = options.batchSize ?? 200
  const src = await RespClient.connect(source)
  let dst: RespClient | null = null
  try {
    await src.ping()
    const total = await src.dbsize()
    dst = await RespClient.connect(target)
    await dst.ping()

    let cursor = '0'
    let scanned = 0
    let restored = 0
    do {
      const { cursor: next, keys } = await src.scan(cursor, batchSize)
      cursor = next
      if (keys.length === 0) continue

      // DUMP + PTTL for every key in the batch, in one round-trip.
      const probe = await src.pipeline(
        keys.flatMap(
          (k): Array<Array<string | Buffer>> => [
            ['DUMP', k],
            ['PTTL', k],
          ],
        ),
      )

      const restoreCmds: Array<Array<string | Buffer>> = []
      for (let i = 0; i < keys.length; i++) {
        const payload = probe[i * 2]
        const pttl = probe[i * 2 + 1]
        // A key can vanish between SCAN and DUMP; DUMP returns null - skip it.
        if (!Buffer.isBuffer(payload)) continue
        const ttlMs = typeof pttl === 'number' && pttl > 0 ? pttl : 0
        restoreCmds.push([
          'RESTORE',
          keys[i],
          String(ttlMs),
          payload,
          'REPLACE',
        ])
      }

      scanned += keys.length
      if (restoreCmds.length > 0) {
        try {
          await dst.pipeline(restoreCmds)
        } catch (error) {
          const message = (error as Error).message
          // RESTORE rejects a DUMP payload whose RDB version is newer than the
          // target supports - i.e. the source is a newer engine version than
          // the target. Surface that plainly instead of the raw checksum error.
          if (/DUMP payload version|checksum are wrong/i.test(message)) {
            throw new Error(
              `The target is an older engine version than the source, so its binary format is incompatible (${message}). Provision the target at the same major version as the source, or newer, and retry.`,
            )
          }
          throw error
        }
        restored += restoreCmds.length
      }
      options.onProgress?.({ scanned, restored, total })
    } while (cursor !== '0')

    return { keysCopied: restored, total }
  } finally {
    src.close()
    if (dst) dst.close()
  }
}
