import { describe, it } from 'node:test'
import {
  copyRedisKeyspace,
  nextStreamId,
  shouldFallBackToLogicalCopy,
  annotateHandshakeError,
} from '../../engines/redis/resp-client'
import {
  respArray,
  respBulk,
  respError,
  respInteger,
  respNil,
  respOk,
  respScan,
  startFakeRespServer,
  withHandshake,
  type FakeRespHandler,
  type FakeRespRequest,
} from '../utils/fake-resp-server'
import {
  assert,
  assertDeepEqual,
  assertEqual,
  assertTruthy,
} from '../utils/assertions'

// Redis and Valkey stamp DUMP payloads with RDB versions from different number
// spaces (measured 2026-09-09: Redis 7.2 = 11, Redis 8.x = 12, Upstash = 14,
// Valkey 8.0 = 11, Valkey 9.0 = 80), so a cross-family RESTORE is refused with
// this exact text. It is the trigger for the type-aware fallback.
const RDB_REFUSAL = 'ERR DUMP payload version or checksum are wrong'

type Scenario = {
  source: FakeRespHandler
  target: FakeRespHandler
  dbsize?: number
  strategy?: 'dump-restore' | 'logical'
  // Skip the canned handshake so a scenario can fail AUTH/PING itself.
  rawSource?: boolean
}

async function runCopy(scenario: Scenario) {
  const src = await startFakeRespServer(
    scenario.rawSource
      ? scenario.source
      : withHandshake(scenario.dbsize ?? 1, scenario.source),
  )
  const dst = await startFakeRespServer(withHandshake(0, scenario.target))
  try {
    const result = await copyRedisKeyspace(
      {
        host: '127.0.0.1',
        port: src.port,
        tls: false,
        // Set so the client actually sends AUTH: the handshake-failure
        // scenarios below answer it, and `withHandshake` +OKs it otherwise.
        password: 'pw',
        connectTimeoutMs: 2000,
        idleTimeoutMs: 2000,
      },
      {
        host: '127.0.0.1',
        port: dst.port,
        tls: false,
        connectTimeoutMs: 2000,
        idleTimeoutMs: 2000,
      },
      { strategy: scenario.strategy },
    )
    return {
      result,
      sourceRequests: src.received,
      targetRequests: dst.received,
    }
  } finally {
    await src.close()
    await dst.close()
  }
}

async function expectCopyToThrow(scenario: Scenario): Promise<Error> {
  try {
    await runCopy(scenario)
  } catch (error) {
    assert(error instanceof Error, 'the copy must reject with a real Error')
    return error
  }
  throw new Error('expected the copy to reject, but it resolved')
}

// The one-key source used by most scenarios: SCAN hands back `k1`, and the
// type-aware reads answer for a plain string.
function singleStringSource(overrides: FakeRespHandler = () => undefined) {
  const handler: FakeRespHandler = (request, socket) => {
    const override = overrides(request, socket)
    if (override) return override
    switch (request.name) {
      case 'SCAN':
        return respScan('0', ['k1'])
      case 'DUMP':
        return respBulk(Buffer.from([0x00, 0x01, 0x76, 0x0b, 0x00]))
      case 'PTTL':
        return respInteger(-1)
      case 'TYPE':
        return Buffer.from('+string\r\n')
      case 'GET':
        return respBulk('v1')
      default:
        return respOk()
    }
  }
  return handler
}

function writesOf(requests: FakeRespRequest[]): string[] {
  return requests
    .filter((r) => !['AUTH', 'PING', 'SELECT', 'DBSIZE'].includes(r.name))
    .map((r) => [r.name, ...r.text].join(' '))
}

describe('Redis keyspace copy: DUMP/RESTORE fast path', () => {
  it('uses DUMP/RESTORE when the target accepts the payload format', async () => {
    const { result, targetRequests } = await runCopy({
      source: singleStringSource(),
      target: () => respOk(),
    })

    assertEqual(result.strategy, 'dump-restore', 'the fast path should be used')
    assertEqual(result.keysCopied, 1, 'the key should be copied')
    assert(
      targetRequests.some((r) => r.name === 'RESTORE'),
      'the target should receive a RESTORE',
    )
    assert(
      !targetRequests.some((r) => r.name === 'SET'),
      'the type-aware path must not run when the fast path works',
    )
  })

  it('does not treat a key that vanished between SCAN and DUMP as a failure', async () => {
    const { result } = await runCopy({
      source: singleStringSource((request) =>
        request.name === 'DUMP' ? respNil() : undefined,
      ),
      target: () => respOk(),
    })

    assertEqual(result.keysCopied, 0, 'a vanished key copies nothing')
    assertEqual(result.strategy, 'dump-restore', 'and is not a format problem')
  })
})

describe('Redis keyspace copy: falling back to the type-aware path', () => {
  it('switches strategy when the target refuses the RDB version', async () => {
    const { result, targetRequests } = await runCopy({
      source: singleStringSource(),
      target: (request) =>
        request.name === 'RESTORE' ? respError(RDB_REFUSAL) : respOk(),
    })

    assertEqual(
      result.strategy,
      'logical',
      'a refused payload format must fall back, not fail',
    )
    assertEqual(result.keysCopied, 1, 'the key still has to arrive')
    assertDeepEqual(
      writesOf(targetRequests).filter((w) => w.startsWith('SET')),
      ['SET k1 v1'],
      'the value should be rewritten with a type-specific command',
    )
  })

  it('switches strategy when the source does not implement DUMP', async () => {
    const { result } = await runCopy({
      source: singleStringSource((request) =>
        request.name === 'DUMP'
          ? respError("ERR unknown command 'DUMP'")
          : undefined,
      ),
      target: () => respOk(),
    })

    assertEqual(result.strategy, 'logical', 'a missing DUMP must fall back')
    assertEqual(result.keysCopied, 1, 'the key still has to arrive')
  })

  it('switches when a serverless provider reports the command as unavailable', async () => {
    const { result } = await runCopy({
      source: singleStringSource((request) =>
        request.name === 'DUMP'
          ? respError("ERR Command is not available: 'DUMP'")
          : undefined,
      ),
      target: () => respOk(),
    })

    assertEqual(result.strategy, 'logical', 'Upstash-shaped refusals fall back')
  })

  it('stays on the type-aware path once it has switched', async () => {
    let scanCalls = 0
    const source: FakeRespHandler = (request) => {
      switch (request.name) {
        case 'SCAN':
          scanCalls++
          // Two pages, so a second batch runs after the switch.
          return scanCalls === 1 ? respScan('7', ['k1']) : respScan('0', ['k2'])
        case 'DUMP':
          return respBulk(Buffer.from([0x00, 0x01, 0x76, 0x0b, 0x00]))
        case 'PTTL':
          return respInteger(-1)
        case 'TYPE':
          return Buffer.from('+string\r\n')
        case 'GET':
          return respBulk('v')
        default:
          return respOk()
      }
    }
    const { result, sourceRequests } = await runCopy({
      dbsize: 2,
      source,
      target: (request) =>
        request.name === 'RESTORE' ? respError(RDB_REFUSAL) : respOk(),
    })

    assertEqual(result.keysCopied, 2, 'both pages should be copied')
    assertEqual(
      sourceRequests.filter((r) => r.name === 'DUMP').length,
      1,
      'DUMP must not be retried after the format was refused once',
    )
  })

  it('fails rather than falling back when one key blows up for another reason', async () => {
    const error = await expectCopyToThrow({
      source: singleStringSource(),
      target: (request) =>
        request.name === 'RESTORE'
          ? respError('OOM command not allowed when used memory > maxmemory')
          : respOk(),
    })

    assert(
      /OOM command not allowed/.test(error.message),
      `a real failure must surface verbatim, got: ${error.message}`,
    )
  })
})

describe('Redis keyspace copy: type-aware reads and writes', () => {
  const collectionSource = (
    type: string,
    first: Buffer,
    extra: FakeRespHandler = () => undefined,
  ): FakeRespHandler => {
    return (request, socket) => {
      const override = extra(request, socket)
      if (override) return override
      switch (request.name) {
        case 'SCAN':
          return respScan('0', ['k1'])
        case 'DUMP':
          // A well-formed payload, so the fast path is genuinely tried and the
          // target's refusal is what drives the fallback.
          return respBulk(Buffer.from([0x00, 0x01, 0x76, 0x0b, 0x00]))
        case 'PTTL':
          return respInteger(-1)
        case 'TYPE':
          return Buffer.from(`+${type}\r\n`)
        case 'HSCAN':
        case 'SSCAN':
        case 'ZSCAN':
        case 'LRANGE':
        case 'XRANGE':
        case 'GET':
          return first
        default:
          return respOk()
      }
    }
  }

  const forceLogical: Scenario['target'] = (request) =>
    request.name === 'RESTORE' ? respError(RDB_REFUSAL) : respOk()

  it('rewrites a hash with HSET after clearing the key', async () => {
    const { targetRequests } = await runCopy({
      source: collectionSource('hash', respScan('0', ['f1', 'v1', 'f2', 'v2'])),
      target: forceLogical,
    })

    assertDeepEqual(
      writesOf(targetRequests).filter(
        (w) => w.startsWith('HSET') || w.startsWith('DEL'),
      ),
      ['DEL k1', 'HSET k1 f1 v1 f2 v2'],
      'a hash is replaced, never merged into whatever was there',
    )
  })

  it('rewrites a zset with the score before the member', async () => {
    const { targetRequests } = await runCopy({
      // ZSCAN yields member,score pairs; ZADD wants score,member.
      source: collectionSource('zset', respScan('0', ['m1', '1.5', 'm2', '2'])),
      target: forceLogical,
    })

    assertDeepEqual(
      writesOf(targetRequests).filter((w) => w.startsWith('ZADD')),
      ['ZADD k1 1.5 m1 2 m2'],
      'ZSCAN pairs must be flipped for ZADD or the scores land as members',
    )
  })

  it('rewrites a list in order with RPUSH', async () => {
    const { targetRequests } = await runCopy({
      source: collectionSource(
        'list',
        respArray(['a', 'b', 'c'].map(respBulk)),
      ),
      target: forceLogical,
    })

    assertDeepEqual(
      writesOf(targetRequests).filter((w) => w.startsWith('RPUSH')),
      ['RPUSH k1 a b c'],
      'list order has to be preserved',
    )
  })

  it('rewrites a set with SADD', async () => {
    const { targetRequests } = await runCopy({
      source: collectionSource('set', respScan('0', ['m1', 'm2'])),
      target: forceLogical,
    })

    assertDeepEqual(
      writesOf(targetRequests).filter((w) => w.startsWith('SADD')),
      ['SADD k1 m1 m2'],
      'set members should be added in one command',
    )
  })

  it('replays stream entries under their original ids', async () => {
    const entry = (id: string, value: string) =>
      respArray([respBulk(id), respArray([respBulk('f'), respBulk(value)])])
    const { targetRequests } = await runCopy({
      source: collectionSource(
        'stream',
        respArray([entry('1-1', 'a'), entry('2-5', 'b')]),
      ),
      target: forceLogical,
    })

    assertDeepEqual(
      writesOf(targetRequests).filter((w) => w.startsWith('XADD')),
      ['XADD k1 1-1 f a', 'XADD k1 2-5 f b'],
      'stream ids must be replayed exactly, not regenerated',
    )
  })

  it('asks for the next stream page at an id a Number cannot represent', async () => {
    // The paging walk only continues when a page comes back FULL, so this needs
    // a real chunk-sized first page. Its last id sits at 2^53, where
    // `Number(seq) + 1` returns the same value - which would make the walk
    // re-request the page it just read, forever.
    const CHUNK = 512
    const bigSeq = '9007199254740992'
    const entry = (id: string) =>
      respArray([respBulk(id), respArray([respBulk('f'), respBulk('v')])])
    const firstPage = respArray(
      Array.from({ length: CHUNK }, (_, i) =>
        entry(i === CHUNK - 1 ? `5-${bigSeq}` : `5-${i}`),
      ),
    )
    let xrangeCalls = 0
    const source: FakeRespHandler = (request) => {
      switch (request.name) {
        case 'SCAN':
          return respScan('0', ['k1'])
        case 'DUMP':
          return respBulk(Buffer.from([0x00, 0x01, 0x76, 0x0b, 0x00]))
        case 'PTTL':
          return respInteger(-1)
        case 'TYPE':
          return Buffer.from('+stream\r\n')
        case 'XRANGE':
          xrangeCalls++
          // The second call ends the walk, so the assertion is about the id it
          // was asked for, not about what comes back.
          return xrangeCalls === 1 ? firstPage : respArray([])
        default:
          return respOk()
      }
    }

    const { sourceRequests } = await runCopy({
      source,
      target: (request) =>
        request.name === 'RESTORE' ? respError(RDB_REFUSAL) : respOk(),
    })

    const continuation = sourceRequests.filter((r) => r.name === 'XRANGE')[1]
    assertTruthy(continuation, 'the full page should have been followed up')
    assertEqual(
      continuation.text[1],
      '5-9007199254740993',
      'the next page must start one past the last id, exactly',
    )
  })

  it('carries a TTL across as a millisecond expiry', async () => {
    const { targetRequests } = await runCopy({
      source: collectionSource('string', respBulk('v1'), (request) =>
        request.name === 'PTTL' ? respInteger(90_000) : undefined,
      ),
      target: forceLogical,
    })

    assertDeepEqual(
      writesOf(targetRequests).filter((w) => w.startsWith('SET')),
      ['SET k1 v1 PX 90000'],
      'a string keeps its expiry in the same command',
    )
  })

  it('round-trips binary keys and values byte for byte', async () => {
    const binaryKey = Buffer.from([0xff, 0x00, 0x41])
    const binaryValue = Buffer.from([0x00, 0xff, 0xfe])
    const source: FakeRespHandler = (request) => {
      switch (request.name) {
        case 'SCAN':
          return respArray([respBulk('0'), respArray([respBulk(binaryKey)])])
        case 'PTTL':
          return respInteger(-1)
        case 'TYPE':
          return Buffer.from('+string\r\n')
        case 'GET':
          return respBulk(binaryValue)
        default:
          return respOk()
      }
    }
    const { targetRequests } = await runCopy({
      source,
      target: forceLogical,
      strategy: 'logical',
    })

    const set = targetRequests.find((r) => r.name === 'SET')
    assertTruthy(set, 'the target should receive a SET')
    assert(
      set.args[0].equals(binaryKey) && set.args[1].equals(binaryValue),
      'binary keys and values must not be mangled by a text round-trip',
    )
  })

  it('skips module types it cannot rewrite and names them', async () => {
    const { result } = await runCopy({
      source: collectionSource('ReJSON-RL', respOk()),
      target: forceLogical,
      strategy: 'logical',
    })

    assertEqual(result.keysCopied, 0, 'a module type cannot be copied')
    assertEqual(result.skipped, 1, 'it should be counted as skipped')
    assertDeepEqual(
      result.skippedTypes,
      ['ReJSON-RL'],
      'and the type should be named so the report can say why',
    )
  })

  it('treats a key that expired between SCAN and TYPE as a non-event', async () => {
    const { result } = await runCopy({
      source: collectionSource('none', respNil()),
      target: forceLogical,
      strategy: 'logical',
    })

    assertEqual(result.keysCopied, 0, 'nothing to copy')
    assertEqual(result.skipped, 0, 'and nothing to warn about')
  })
})

describe('Redis keyspace copy: connection failure shapes', () => {
  const failing = (handler: FakeRespHandler) =>
    expectCopyToThrow({
      source: handler,
      target: () => respOk(),
      rawSource: true,
    })

  it('reports a rejected password with the fix', async () => {
    const error = await failing(() =>
      respError(
        'WRONGPASS invalid username-password pair or user is disabled.',
      ),
    )
    assert(
      /WRONGPASS/.test(error.message) &&
        /Copy the URL again/.test(error.message),
      `expected the server text plus a hint, got: ${error.message}`,
    )
  })

  it('names the protocol when the peer does not speak RESP at all', async () => {
    // A TLS-only endpoint reached over plain redis:// answers with a TLS alert
    // record. It carries no CRLF, so the parser used to wait for a line
    // terminator that never came and the migration hung until it was killed.
    const error = await failing(() =>
      Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46]),
    )
    assert(
      /did not answer with the Redis protocol/.test(error.message) &&
        /rediss:\/\//.test(error.message),
      `expected a protocol-mismatch message, got: ${error.message}`,
    )
  })

  it('names the protocol when an HTTP server answers on the port', async () => {
    const error = await failing(() =>
      Buffer.from('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'),
    )
    assert(
      /did not answer with the Redis protocol/.test(error.message),
      `expected a protocol-mismatch message, got: ${error.message}`,
    )
  })

  it('gives up when the peer accepts the connection and then goes silent', async () => {
    const error = await failing(
      withHandshake(1, (request) =>
        request.name === 'SCAN' ? respScan('0', ['k1']) : undefined,
      ),
    )
    assert(
      /stopped responding/.test(error.message),
      `expected an idle-timeout message, got: ${error.message}`,
    )
  })

  it('reports a closed connection rather than hanging', async () => {
    const error = await failing((_request, socket) => {
      socket.destroy()
    })
    assert(
      /Redis connection closed/.test(error.message),
      `expected a closed-connection message, got: ${error.message}`,
    )
  })

  it('never rejects with an empty message', async () => {
    // A bare `-\r\n` reply. An Error whose message is '' serializes to nothing,
    // which is how a failure reached users as a detail-free `{}`.
    const error = await failing(() => Buffer.from('-\r\n'))
    assert(
      error.message.length > 0,
      'an empty error reply must still produce readable text',
    )
  })
})

// Both halves of a stream id are unsigned 64-bit. The paging walk asks for the
// next page starting at seq+1 of the last id it saw, so the increment has to be
// exact for every value a real stream can reach - well past what a Number holds.
describe('Stream id paging arithmetic', () => {
  it('increments an ordinary sequence', () => {
    assertEqual(nextStreamId('1526919030474-55'), '1526919030474-56', 'seq+1')
    assertEqual(nextStreamId('1526919030474-0'), '1526919030474-1', 'from zero')
  })

  it('treats a bare millisecond id as sequence zero', () => {
    assertEqual(nextStreamId('1526919030474'), '1526919030474-1', 'implicit 0')
  })

  it('is exact at 2^53, where Number stops being able to count', () => {
    // 9007199254740992 is Number.MAX_SAFE_INTEGER + 1. `Number(x) + 1` returns
    // the SAME value here, so the walk would re-request the page it just read
    // and loop forever on a stream that reached this sequence.
    assertEqual(
      nextStreamId('5-9007199254740992'),
      '5-9007199254740993',
      'the id after 2^53 must be 2^53 + 1, not 2^53',
    )
    assertEqual(
      nextStreamId('5-9007199254740993'),
      '5-9007199254740994',
      'and it must keep counting one at a time above that',
    )
  })

  it('is exact well beyond 2^53', () => {
    assertEqual(
      nextStreamId('1526919030474-18446744073709551614'),
      '1526919030474-18446744073709551615',
      'one below the uint64 ceiling still just increments',
    )
  })

  it('carries into the next millisecond at the uint64 ceiling', () => {
    // 18446744073709551615 is 2^64 - 1, the largest sequence a stream id can
    // hold. `Number(...) + 1` gives 18446744073709552000 - an id that is not
    // next and is not in the stream, so the tail would be skipped silently.
    assertEqual(
      nextStreamId('1526919030474-18446744073709551615'),
      '1526919030475-0',
      'a full sequence rolls into the next millisecond, as Redis does',
    )
  })

  it('refuses an id it cannot read rather than inventing one', () => {
    for (const bad of ['', 'abc', '5-', '5-x', '-1', '1-2-3']) {
      let threw = false
      try {
        nextStreamId(bad)
      } catch {
        threw = true
      }
      assert(threw, `"${bad}" is not a stream id and must not be guessed at`)
    }
  })
})

describe('Redis copy fallback signatures', () => {
  it('recognises the refusals that mean the format is foreign', () => {
    for (const message of [
      'ERR DUMP payload version or checksum are wrong',
      'ERR Bad data format',
      "ERR unknown command 'DUMP'",
      "ERR Command is not available: 'DUMP'",
    ]) {
      assert(
        shouldFallBackToLogicalCopy(message),
        `"${message}" should trigger the type-aware fallback`,
      )
    }
  })

  it('does not swallow failures that are nothing to do with the format', () => {
    for (const message of [
      'OOM command not allowed when used memory > maxmemory',
      'READONLY You cannot write against a read only replica',
      'MOVED 1234 10.0.0.1:6379',
      'LOADING Redis is loading the dataset in memory',
    ]) {
      assert(
        !shouldFallBackToLogicalCopy(message),
        `"${message}" must fail the copy, not silently change strategy`,
      )
    }
  })

  it('keeps the server text when it appends a hint', () => {
    const annotated = annotateHandshakeError(
      new Error('NOAUTH Authentication required.'),
    )
    assert(
      annotated.message.startsWith('NOAUTH Authentication required.'),
      `the server text must lead, got: ${annotated.message}`,
    )
    assert(
      !/\.\.\s/.test(annotated.message),
      `the hint must not double the sentence terminator, got: ${annotated.message}`,
    )
  })

  it('leaves an unrecognised error untouched', () => {
    const original = new Error('ERR something we have never seen')
    assertEqual(
      annotateHandshakeError(original),
      original,
      'no hint means no rewrapping',
    )
  })
})
