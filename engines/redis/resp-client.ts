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
      // A bare `-\r\n` carries no text at all. An Error with an empty message
      // is indistinguishable from "no error" once it is serialized, so name it.
      return {
        value: new Error(line || 'The server returned an empty error reply'),
        offset: lineEnd,
      }
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
      throw new Error(
        `Unsupported RESP reply type: ${String.fromCharCode(type)}`,
      )
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
  // How long the socket may go completely silent while a command is in flight
  // before the connection is failed. Without this a peer that accepts the TCP
  // connection and then never speaks RESP wedges the copy forever - there is no
  // reply to parse, so nothing else ever fires. See `onIdle`.
  idleTimeoutMs?: number
}

// The first byte of every reply RESP2 can produce. Anything else means we are
// not talking to a Redis server on this port - a TLS record, an HTTP response,
// or a RESP3 reply from a server that volunteered one. Bailing out on sight is
// what keeps a mis-typed `redis://` against a TLS-only endpoint from hanging:
// those bytes carry no CRLF, so the incremental parser would otherwise wait for
// a line terminator that never arrives.
const RESP2_REPLY_TYPES = new Set([0x2b, 0x2d, 0x3a, 0x24, 0x2a])

// Usernames that name no real ACL user, so AUTH must be sent in its
// one-argument form (`AUTH <password>`) instead of `AUTH <user> <password>`.
//
// - `default` is Redis's implicit ACL user, which `requirepass`-only servers
//   reject when it is passed explicitly.
// - `h` is Heroku's legacy convention: the classic Redis add-on minted URLs
//   like `rediss://h:<password>@host:port` where `h` is a dummy placeholder,
//   not an account. (Modern Heroku Key-Value URLs leave the username empty.)
//   Sending `AUTH h <password>` to those servers fails with WRONGPASS.
//
// Matching is exact, never trimmed or lowercased, so a real ACL user whose
// name merely starts with `h` (`hasura`) is untouched. The redis-cli paths
// share this set through `shouldPassRedisCliUsername()` in `cli-common.ts`.
export const IMPLICIT_RESP_USERNAMES = new Set(['default', 'h'])

// Build the AUTH command for a connection. Exported for unit testing.
export function buildRespAuthArgs(
  password: string,
  username?: string,
): string[] {
  return username && !IMPLICIT_RESP_USERNAMES.has(username)
    ? ['AUTH', username, password]
    : ['AUTH', password]
}

// The handshake rejections a pasted connection string actually produces, each
// with the one sentence that says what to change. The server's own text is
// always kept - it is the ground truth - and the hint is appended.
const HANDSHAKE_HINTS: Array<{ match: RegExp; hint: string }> = [
  {
    match: /^WRONGPASS/i,
    hint: 'The username or password in the connection string was rejected. Copy the URL again from the provider console - a rotated credential is the usual cause.',
  },
  {
    match: /^NOAUTH/i,
    hint: 'The server wants credentials the connection string does not carry. Use the full redis://user:password@host:port URL.',
  },
  {
    match: /Client sent AUTH, but no password is set/i,
    hint: 'The connection string carries a password but the server has none configured. Drop the credentials from the URL.',
  },
  {
    match: /wrong number of arguments for 'auth'/i,
    hint: 'This server predates ACL users (Redis 5 or older), so it only accepts a password. Remove the username from the connection string.',
  },
  {
    match: /DB index is out of range|SELECT is not allowed/i,
    hint: 'The source does not have the numbered database from the end of the URL. Most managed Redis exposes only db 0 - drop the /N suffix.',
  },
]

export function annotateHandshakeError(error: Error): Error {
  const hint = HANDSHAKE_HINTS.find((h) => h.match.test(error.message))?.hint
  if (!hint) return error
  // Server messages end with a period about half the time; do not double it.
  const text = error.message.replace(/\.\s*$/, '')
  return new Error(`${text}. ${hint}`)
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

  private constructor(socket: Socket, idleTimeoutMs: number) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (err: Error) => this.onFatal(err))
    socket.on('close', () => this.onFatal(new Error('Redis connection closed')))
    if (idleTimeoutMs > 0) {
      socket.setTimeout(idleTimeoutMs)
      socket.on('timeout', () => this.onIdle(idleTimeoutMs))
    }
  }

  private onData(chunk: Buffer): void {
    this.inbox =
      this.inbox.length === 0 ? chunk : Buffer.concat([this.inbox, chunk])
    let offset = 0
    for (;;) {
      if (
        offset < this.inbox.length &&
        !RESP2_REPLY_TYPES.has(this.inbox[offset])
      ) {
        this.onFatal(
          new Error(
            'The server did not answer with the Redis protocol (first reply byte ' +
              `0x${this.inbox[offset].toString(16).padStart(2, '0')}). ` +
              'If the source requires TLS, use rediss:// instead of redis://; ' +
              'if it is behind an HTTP proxy or a REST-only endpoint, point at the ' +
              'database port instead.',
          ),
        )
        this.socket.destroy()
        return
      }
      // A malformed reply must not escape as an uncaught exception: `onData`
      // runs on the socket's 'data' event, so a throw here would take the whole
      // process down mid-migration with no --json output at all.
      let parsed: { value: RespReply; offset: number } | null
      try {
        parsed = parseReply(this.inbox, offset)
      } catch (error) {
        this.onFatal(error instanceof Error ? error : new Error(String(error)))
        this.socket.destroy()
        return
      }
      if (!parsed) break
      offset = parsed.offset
      const waiter = this.queue.shift()
      if (!waiter) continue // unexpected push (e.g. server-side); ignore
      if (parsed.value instanceof Error) waiter.reject(parsed.value)
      else waiter.resolve(parsed.value)
    }
    this.inbox = offset === 0 ? this.inbox : this.inbox.subarray(offset)
  }

  // Socket inactivity. Only fatal while we are actually waiting on a reply -
  // an idle connection between commands is normal and must not be torn down.
  private onIdle(idleTimeoutMs: number): void {
    if (this.queue.length === 0) return
    this.onFatal(
      new Error(
        `The Redis server stopped responding (no reply for ${idleTimeoutMs}ms with ` +
          `${this.queue.length} command(s) in flight)`,
      ),
    )
    this.socket.destroy()
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

  // Like `pipeline`, but a per-command `-ERR` comes back as an Error VALUE
  // instead of rejecting the batch. The migration needs this to tell "every
  // RESTORE in this batch was refused because the payload format is foreign"
  // (recoverable - fall back to a logical copy) from "one key blew up"
  // (a real failure), which `Promise.all` cannot express: it surfaces the first
  // rejection and hides the rest.
  async pipelineSettled(
    commands: Array<Array<string | Buffer>>,
  ): Promise<Array<RespReply | Error>> {
    if (this.fatal) throw this.fatal
    const promises = commands.map(
      () =>
        new Promise<RespReply>((resolve, reject) => {
          this.queue.push({ resolve, reject })
        }),
    )
    this.socket.write(Buffer.concat(commands.map(encodeCommand)))
    const settled = await Promise.allSettled(promises)
    // A socket-level failure rejects every outstanding waiter with the same
    // Error. That is not a per-command refusal and must not be mistaken for
    // one, so re-throw instead of handing back a list of Errors.
    if (this.fatal) throw this.fatal
    return settled.map((s) =>
      s.status === 'fulfilled'
        ? s.value
        : s.reason instanceof Error
          ? s.reason
          : new Error(String(s.reason)),
    )
  }

  close(): void {
    this.socket.destroy()
  }

  static async connect(opts: RespConnectOptions): Promise<RespClient> {
    const timeoutMs = opts.connectTimeoutMs ?? 15000
    const socket: Socket = await new Promise((resolve, reject) => {
      const s = opts.tls
        ? tlsConnect({
            host: opts.host,
            port: opts.port,
            servername: opts.host,
            rejectUnauthorized: opts.rejectUnauthorized ?? false,
          })
        : netConnect({ host: opts.host, port: opts.port })
      // A rejected connect must not leave the socket open: nothing else holds a
      // reference to it, so the handle would keep the process alive.
      const onError = (err: Error) => {
        s.destroy()
        reject(err)
      }
      const onTimeout = () => {
        s.destroy()
        reject(new Error(`Redis connection timed out after ${timeoutMs}ms`))
      }
      const onReady = () => {
        // Both handlers have to go, not just 'error': the connect deadline is
        // re-armed as an IDLE deadline by the constructor, and leaving this
        // listener attached would tear the socket down on a quiet moment.
        s.removeListener('error', onError)
        s.removeListener('timeout', onTimeout)
        s.setTimeout(0)
        resolve(s)
      }
      s.setTimeout(timeoutMs)
      s.once('timeout', onTimeout)
      s.once('error', onError)
      s.once(opts.tls ? 'secureConnect' : 'connect', onReady)
    })

    const client = new RespClient(socket, opts.idleTimeoutMs ?? timeoutMs * 4)
    try {
      if (opts.password) {
        await client.command(buildRespAuthArgs(opts.password, opts.username))
      }
      if (opts.database && opts.database > 0) {
        await client.command(['SELECT', String(opts.database)])
      }
    } catch (error) {
      client.close()
      throw error instanceof Error ? annotateHandshakeError(error) : error
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
  async scan(
    cursor: string,
    count: number,
  ): Promise<{
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
  strategy: RedisCopyStrategy
}

// How the keyspace is being moved.
//
// - `dump-restore` is the fast path: DUMP hands back Redis's own serialization
//   and RESTORE puts it straight into the target, so every type and TTL
//   round-trips exactly with no per-type code.
// - `logical` reads each key with type-specific commands and rewrites it. It is
//   slower and it cannot carry module types, but it does not care what the two
//   ends serialize with.
export type RedisCopyStrategy = 'dump-restore' | 'logical'

export type RedisCopyResult = {
  keysCopied: number
  total: number
  strategy: RedisCopyStrategy
  // Keys the logical path could not rewrite, by source TYPE. Module types
  // (ReJSON-RL, TSDB-TYPE, MBbloom--) have no portable read/write pair.
  skipped: number
  skippedTypes: string[]
}

// Why the fast path is not always available.
//
// DUMP payloads are stamped with the RDB version of the server that produced
// them, and RESTORE refuses anything its own format does not cover. That is not
// a "the target is too old" problem that a version bump fixes - Redis and Valkey
// now serialize into DIFFERENT number spaces:
//
//   Redis 7.2            RDB 11        Valkey 8.0    RDB 11
//   Redis 8.x            RDB 12        Valkey 9.0    RDB 80
//   Upstash (8.4-compat) RDB 14
//
// so a Valkey 9 source cannot RESTORE into any Redis at all, and a Redis 8 or
// Upstash source cannot RESTORE into Redis 7.2 or Valkey. Measured 2026-09-09
// against live servers of each. A serverless provider may also simply not
// implement DUMP. Either way the answer is the same: stop trying to move bytes
// and move values instead.
function isPayloadFormatRefusal(message: string): boolean {
  return /DUMP payload version or checksum are wrong|Bad data format/i.test(
    message,
  )
}

function isCommandUnavailable(message: string): boolean {
  return /unknown command|Command is not available|unsupported command|ERR .*not supported/i.test(
    message,
  )
}

export function shouldFallBackToLogicalCopy(message: string): boolean {
  return isPayloadFormatRefusal(message) || isCommandUnavailable(message)
}

// The TARGET is full: it has a `maxmemory` and the copy reached it.
//
// This is NOT a fallback case. Neither strategy can write a key the server has
// refused to store, so retrying with the logical path would only walk into the
// same wall more slowly. It is also the one copy failure whose fix belongs to
// the operator rather than to spindb, so it gets said plainly instead of being
// handed over as a bare server code.
//
// `MISCONF` is included because it fails writes identically from the caller's
// side (the server refusing writes after a failed background save), and a
// restore that dies at either one leaves the same half-populated keyspace.
function isTargetOutOfMemory(message: string): boolean {
  return /^(?:\(error\)\s*)?(?:OOM|MISCONF)\b/m.test(message.trim())
}

/**
 * Restate a target-side write refusal in terms the person running the copy can
 * act on, leaving every other error exactly as the server sent it.
 */
export function describeTargetWriteFailure(error: Error): Error {
  if (!isTargetOutOfMemory(error.message)) return error
  return new Error(
    `The target database is out of memory and refused the write, so only part ` +
      `of the keyspace was copied. Its maxmemory is smaller than the source's ` +
      `data. Raise the target's memory limit, or reduce what is being copied, ` +
      `then run the copy again. (${error.message.trim()})`,
  )
}

// Value types the logical path knows how to read and rewrite.
const LOGICAL_COPY_TYPES = new Set([
  'string',
  'list',
  'set',
  'zset',
  'hash',
  'stream',
])

// Elements pulled per read round-trip, and written per command. Keeps a single
// reply (and a single command) bounded regardless of how large one key is, which
// matters both for our own memory and for providers that cap response size.
// Kept EVEN on purpose: hashes and sorted sets are written as field/value and
// score/member PAIRS, and an odd chunk would split one across two commands.
const ELEMENT_CHUNK = 512

function replyToBuffer(reply: RespReply): Buffer | null {
  return Buffer.isBuffer(reply) ? reply : null
}

function replyToString(reply: RespReply): string {
  if (Buffer.isBuffer(reply)) return reply.toString('latin1')
  if (typeof reply === 'string') return reply
  return ''
}

function replyToBuffers(reply: RespReply): Buffer[] {
  return Array.isArray(reply)
    ? reply.filter((r): r is Buffer => Buffer.isBuffer(r))
    : []
}

// A *SCAN reply: [cursor, [element, ...]].
function parseScanReply(reply: RespReply): {
  cursor: string
  items: Buffer[]
} {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new Error('Unexpected SCAN reply while reading a collection')
  }
  return { cursor: replyToString(reply[0]), items: replyToBuffers(reply[1]) }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

// The first read for a key of this type. Every one of these returns whatever
// fits in a single chunk, so a batch of keys can be read in ONE round-trip and
// only the oversized ones need a follow-up walk.
function firstReadCommand(
  type: string,
  key: Buffer,
): Array<string | Buffer> | null {
  switch (type) {
    case 'string':
      return ['GET', key]
    case 'hash':
      return ['HSCAN', key, '0', 'COUNT', String(ELEMENT_CHUNK)]
    case 'set':
      return ['SSCAN', key, '0', 'COUNT', String(ELEMENT_CHUNK)]
    case 'zset':
      return ['ZSCAN', key, '0', 'COUNT', String(ELEMENT_CHUNK)]
    case 'list':
      return ['LRANGE', key, '0', String(ELEMENT_CHUNK - 1)]
    case 'stream':
      return ['XRANGE', key, '-', '+', 'COUNT', String(ELEMENT_CHUNK)]
    default:
      return null
  }
}

// The largest sequence a stream id can hold: both halves of a stream id are
// unsigned 64-bit, and Redis rolls a full sequence over into the next
// millisecond rather than refusing the entry.
const STREAM_ID_PART_MAX = 18446744073709551615n

// Stream ids are `<ms>-<seq>`. XRANGE ranges are inclusive, and the exclusive
// `(` form only exists from Redis 6.2, so the next page starts at seq+1 of the
// last id we saw - a form every version understands.
//
// The arithmetic is BigInt because both halves are uint64 and a Number cannot
// hold one past 2^53. `Number('9007199254740993') + 1` is 9007199254740994 by
// luck, but `Number('18446744073709551615') + 1` is 18446744073709552000 - a
// value that is not the next id and is not even in the stream, so the walk
// would silently skip the tail of a large stream. A sequence that is already at
// the maximum carries into the next millisecond, exactly as Redis does when it
// assigns one.
export function nextStreamId(id: string): string {
  const match = /^(\d+)(?:-(\d+))?$/.exec(id)
  if (!match) {
    throw new Error(`Unexpected stream entry id from the source: ${id}`)
  }
  const ms = BigInt(match[1])
  const seq = match[2] === undefined ? 0n : BigInt(match[2])
  return seq >= STREAM_ID_PART_MAX ? `${ms + 1n}-0` : `${ms}-${seq + 1n}`
}

type StreamEntry = { id: string; fields: Buffer[] }

function parseStreamEntries(reply: RespReply): StreamEntry[] {
  if (!Array.isArray(reply)) return []
  const entries: StreamEntry[] = []
  for (const item of reply) {
    if (!Array.isArray(item) || item.length < 2) continue
    entries.push({
      id: replyToString(item[0]),
      fields: replyToBuffers(item[1]),
    })
  }
  return entries
}

// Everything read out of the source for one key, in the shape the writer wants.
type KeyContents =
  | { kind: 'string'; value: Buffer }
  | {
      kind: 'elements'
      type: 'hash' | 'set' | 'zset' | 'list'
      items: Buffer[]
    }
  | { kind: 'stream'; entries: StreamEntry[] }
  | { kind: 'skip'; type: string }

// Finish reading a key whose first chunk came back full. `first` is that chunk.
async function readRemainder(
  src: RespClient,
  key: Buffer,
  type: string,
  first: RespReply,
): Promise<KeyContents> {
  switch (type) {
    case 'string': {
      const value = replyToBuffer(first)
      // A key that vanished between SCAN and GET is a non-event, not an error.
      return value ? { kind: 'string', value } : { kind: 'skip', type: 'none' }
    }
    case 'hash':
    case 'set':
    case 'zset': {
      const { cursor, items } = parseScanReply(first)
      const all = items
      let next = cursor
      while (next !== '0') {
        const page = parseScanReply(
          await src.command([
            type === 'hash' ? 'HSCAN' : type === 'set' ? 'SSCAN' : 'ZSCAN',
            key,
            next,
            'COUNT',
            String(ELEMENT_CHUNK),
          ]),
        )
        all.push(...page.items)
        next = page.cursor
      }
      return { kind: 'elements', type, items: all }
    }
    case 'list': {
      const all = replyToBuffers(first)
      // A short page means the end of the list; a full one means there may be
      // more, so keep walking from where the last page stopped.
      while (all.length > 0 && all.length % ELEMENT_CHUNK === 0) {
        const page = replyToBuffers(
          await src.command([
            'LRANGE',
            key,
            String(all.length),
            String(all.length + ELEMENT_CHUNK - 1),
          ]),
        )
        if (page.length === 0) break
        all.push(...page)
      }
      return { kind: 'elements', type: 'list', items: all }
    }
    case 'stream': {
      const entries = parseStreamEntries(first)
      while (entries.length > 0 && entries.length % ELEMENT_CHUNK === 0) {
        const page = parseStreamEntries(
          await src.command([
            'XRANGE',
            key,
            nextStreamId(entries[entries.length - 1].id),
            '+',
            'COUNT',
            String(ELEMENT_CHUNK),
          ]),
        )
        if (page.length === 0) break
        entries.push(...page)
      }
      return { kind: 'stream', entries }
    }
    default:
      return { kind: 'skip', type }
  }
}

// The commands that recreate one key on the target. A collection is DELeted
// first so a re-run replaces it instead of appending to it - the same
// replace-in-place semantics RESTORE ... REPLACE gives the fast path.
function writeCommands(
  key: Buffer,
  contents: KeyContents,
  ttlMs: number,
): Array<Array<string | Buffer>> {
  const cmds: Array<Array<string | Buffer>> = []
  if (contents.kind === 'string') {
    // SET replaces a key of ANY previous type, so it needs no DEL, and PX folds
    // the expiry into the same command.
    cmds.push(
      ttlMs > 0
        ? ['SET', key, contents.value, 'PX', String(ttlMs)]
        : ['SET', key, contents.value],
    )
    return cmds
  }
  if (contents.kind === 'elements') {
    if (contents.items.length === 0) return cmds // an empty collection cannot exist
    cmds.push(['DEL', key])
    const writer =
      contents.type === 'hash'
        ? 'HSET'
        : contents.type === 'set'
          ? 'SADD'
          : contents.type === 'zset'
            ? 'ZADD'
            : 'RPUSH'
    // ZSCAN and HSCAN return flat member/score and field/value pairs. ZADD
    // wants score BEFORE member, which is the order ZSCAN already yields
    // reversed, so zsets are re-paired; the others are already in write order.
    const args =
      contents.type === 'zset'
        ? contents.items.flatMap((_, i, arr) =>
            i % 2 === 0 ? [arr[i + 1], arr[i]] : [],
          )
        : contents.items
    for (const part of chunk(args, ELEMENT_CHUNK)) {
      cmds.push([writer, key, ...part])
    }
    if (ttlMs > 0) cmds.push(['PEXPIRE', key, String(ttlMs)])
    return cmds
  }
  if (contents.kind === 'stream') {
    if (contents.entries.length === 0) return cmds
    cmds.push(['DEL', key])
    for (const entry of contents.entries) {
      cmds.push(['XADD', key, entry.id, ...entry.fields])
    }
    if (ttlMs > 0) cmds.push(['PEXPIRE', key, String(ttlMs)])
  }
  return cmds
}

// Read one batch of keys off the source and rewrite them on the target with
// type-specific commands. Returns how many keys landed and which types had to
// be skipped.
async function copyBatchLogically(
  src: RespClient,
  dst: RespClient,
  keys: Buffer[],
): Promise<{ copied: number; skipped: number; skippedTypes: Set<string> }> {
  const probe = await src.pipeline(
    keys.flatMap(
      (k): Array<Array<string | Buffer>> => [
        ['TYPE', k],
        ['PTTL', k],
      ],
    ),
  )
  const types = keys.map((_, i) => replyToString(probe[i * 2]))
  const ttls = keys.map((_, i) => {
    const pttl = probe[i * 2 + 1]
    return typeof pttl === 'number' && pttl > 0 ? pttl : 0
  })

  // One round-trip for the first (and usually only) chunk of every key.
  const readable = keys
    .map((key, i) => ({ key, i, cmd: firstReadCommand(types[i], key) }))
    .filter(
      (r): r is { key: Buffer; i: number; cmd: Array<string | Buffer> } =>
        r.cmd !== null,
    )
  const firsts =
    readable.length > 0 ? await src.pipeline(readable.map((r) => r.cmd)) : []

  const skippedTypes = new Set<string>()
  let skipped = 0
  for (const type of types) {
    // `none` means the key expired or was deleted between SCAN and TYPE.
    if (type !== 'none' && !LOGICAL_COPY_TYPES.has(type)) {
      skippedTypes.add(type)
      skipped++
    }
  }

  const writes: Array<Array<string | Buffer>> = []
  let copied = 0
  for (const [n, entry] of readable.entries()) {
    const contents = await readRemainder(
      src,
      entry.key,
      types[entry.i],
      firsts[n],
    )
    if (contents.kind === 'skip') continue
    const cmds = writeCommands(entry.key, contents, ttls[entry.i])
    if (cmds.length === 0) continue
    writes.push(...cmds)
    copied++
  }
  for (const part of chunk(writes, ELEMENT_CHUNK)) {
    try {
      await dst.pipeline(part)
    } catch (error) {
      // Same restatement as the DUMP/RESTORE path: the logical walk hits the
      // target's ceiling in exactly the same way, and this is the strategy
      // there is no falling back FROM.
      throw describeTargetWriteFailure(
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }
  return { copied, skipped, skippedTypes }
}

// Move one batch with DUMP/RESTORE. Returns null when the target refused the
// payload format (or an end does not implement the commands), which is the
// caller's signal to switch to the logical path for good.
async function copyBatchWithDumpRestore(
  src: RespClient,
  dst: RespClient,
  keys: Buffer[],
): Promise<number | null> {
  const probe = await src.pipelineSettled(
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
    if (payload instanceof Error) {
      // The source will not DUMP at all - nothing to retry, switch strategy.
      if (shouldFallBackToLogicalCopy(payload.message)) return null
      throw payload
    }
    const pttl = probe[i * 2 + 1]
    // A key can vanish between SCAN and DUMP; DUMP returns null - skip it.
    if (!Buffer.isBuffer(payload)) continue
    const ttlMs = typeof pttl === 'number' && pttl > 0 ? pttl : 0
    restoreCmds.push(['RESTORE', keys[i], String(ttlMs), payload, 'REPLACE'])
  }
  if (restoreCmds.length === 0) return 0

  const results = await dst.pipelineSettled(restoreCmds)
  const failures = results.filter((r): r is Error => r instanceof Error)
  if (failures.length === 0) return restoreCmds.length
  if (failures.every((f) => shouldFallBackToLogicalCopy(f.message))) return null
  throw describeTargetWriteFailure(failures[0])
}

// Binary-safe keyspace copy: SCAN the source, move each batch into the target,
// and report progress as it goes. DUMP/RESTORE is tried first because it is
// exact and cheap; the moment the target refuses that payload format the copy
// switches - permanently, and re-doing the batch it was in the middle of - to a
// type-aware read/write walk that does not depend on either end's RDB version.
// Used by the `restore --from-url` path for redis/valkey.
export async function copyRedisKeyspace(
  source: RespConnectOptions,
  target: RespConnectOptions,
  options: {
    batchSize?: number
    // Forces the type-aware path from the first key. The automatic switch
    // covers every case we know of; this exists for tests and for a source
    // whose DUMP is known-bad rather than absent.
    strategy?: RedisCopyStrategy
    onProgress?: (progress: RedisCopyProgress) => void
  } = {},
): Promise<RedisCopyResult> {
  const batchSize = options.batchSize ?? 200
  const src = await RespClient.connect(source)
  let dst: RespClient | null = null
  try {
    await src.ping()
    const total = await src.dbsize()
    dst = await RespClient.connect(target)
    await dst.ping()

    let strategy: RedisCopyStrategy = options.strategy ?? 'dump-restore'
    let cursor = '0'
    let scanned = 0
    let restored = 0
    let skipped = 0
    const skippedTypes = new Set<string>()
    do {
      const { cursor: next, keys } = await src.scan(cursor, batchSize)
      cursor = next
      if (keys.length === 0) continue

      if (strategy === 'dump-restore') {
        const moved = await copyBatchWithDumpRestore(src, dst, keys)
        if (moved !== null) {
          scanned += keys.length
          restored += moved
          options.onProgress?.({ scanned, restored, total, strategy })
          continue
        }
        strategy = 'logical'
      }

      const result = await copyBatchLogically(src, dst, keys)
      scanned += keys.length
      restored += result.copied
      skipped += result.skipped
      for (const t of result.skippedTypes) skippedTypes.add(t)
      options.onProgress?.({ scanned, restored, total, strategy })
    } while (cursor !== '0')

    return {
      keysCopied: restored,
      total,
      strategy,
      skipped,
      skippedTypes: [...skippedTypes].sort(),
    }
  } finally {
    src.close()
    if (dst) dst.close()
  }
}
