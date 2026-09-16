import { describe, it } from 'node:test'
import { hasRedisCliError } from '../../engines/redis/cli-common'
import {
  describeTargetWriteFailure,
  shouldFallBackToLogicalCopy,
} from '../../engines/redis/resp-client'
import { assert, assertEqual } from '../utils/assertions'

// A Redis/Valkey server that refuses a write answers with an error and
// `redis-cli` reading commands from stdin still EXITS 0. Every restore path
// that judged the exit code alone therefore reported success over a database
// that had taken nothing, and `maxmemory` is the setting that makes that
// routine rather than exotic.

const OOM_REPLY =
  "(error) OOM command not allowed when used memory > 'maxmemory'."

describe('hasRedisCliError', () => {
  it('catches an OOM refusal on stdout (the exit code is 0)', () => {
    assert(
      hasRedisCliError(OOM_REPLY, '', true),
      'OOM on stdout must read as an error',
    )
  })

  it('catches the bare, unprefixed form redis-cli prints when piped', () => {
    assert(
      hasRedisCliError(
        "OOM command not allowed when used memory > 'maxmemory'.",
        '',
        true,
      ),
      'an unprefixed OOM must read as an error',
    )
  })

  it('catches a refusal buried in a stream of successful replies', () => {
    // What a real text restore looks like: hundreds of OKs, then the ceiling.
    const stdout = ['OK', 'OK', 'OK', OOM_REPLY, OOM_REPLY].join('\n')
    assert(hasRedisCliError(stdout, '', true), 'a late OOM must still be seen')
  })

  it('catches the other write-refusal classes that fail the same way', () => {
    for (const reply of [
      '(error) MISCONF Errors writing to the RDB snapshots.',
      '(error) READONLY You can not write against a read only replica.',
      '(error) WRONGTYPE Operation against a key holding the wrong kind of value',
    ]) {
      assert(
        hasRedisCliError(reply, '', true),
        `${reply} must read as an error`,
      )
    }
  })

  it('still catches everything it caught before', () => {
    assert(hasRedisCliError('ERR unknown command', '', true), 'ERR')
    assert(
      hasRedisCliError('NOAUTH Authentication required.', '', true),
      'NOAUTH',
    )
    assert(
      hasRedisCliError('WRONGPASS invalid username-password pair', '', true),
      'WRONGPASS',
    )
    assert(
      hasRedisCliError('', 'NOPERM this user has no permissions', true),
      'NOPERM on stderr',
    )
  })

  it('does not fire on a clean run', () => {
    assertEqual(
      hasRedisCliError('OK\nOK\nOK', '', true),
      false,
      'a stream of OKs is not an error',
    )
    assertEqual(
      hasRedisCliError('', '', true),
      false,
      'no output is not an error',
    )
    // A stdout-carried error is ignored when the caller says not to look, as
    // before - only the stderr scan is unconditional.
    assertEqual(
      hasRedisCliError(OOM_REPLY, '', false),
      false,
      'stdout must be ignored when the caller says not to look',
    )
  })
})

describe('describeTargetWriteFailure', () => {
  it('restates an OOM refusal in terms the operator can act on', () => {
    const restated = describeTargetWriteFailure(new Error(OOM_REPLY))
    assert(
      /out of memory/i.test(restated.message),
      'should say the target is out of memory',
    )
    assert(
      /only part of the keyspace/i.test(restated.message),
      'should say the copy is partial',
    )
    assert(
      /maxmemory/i.test(restated.message),
      'should name the setting to change',
    )
    // The server's own words are kept, so the original is never lost.
    assert(
      restated.message.includes('OOM command not allowed'),
      'should keep the raw server error',
    )
  })

  it('restates MISCONF as a persistence failure, not a memory one', () => {
    // MISCONF stops writes the same way an OOM does, but the fix is on the
    // disk/persistence side - pointing the operator at maxmemory would send
    // them to the wrong setting entirely.
    const restated = describeTargetWriteFailure(
      new Error('MISCONF Errors writing to the RDB snapshots.'),
    )
    assert(
      /persistence is failing/i.test(restated.message),
      'should name persistence as the cause',
    )
    assert(
      /disk space/i.test(restated.message) &&
        /stop-writes-on-bgsave-error/i.test(restated.message),
      'should name what to check on the target',
    )
    assert(
      /only part of the keyspace/i.test(restated.message),
      'should still say the copy is partial',
    )
    assert(
      !/maxmemory/i.test(restated.message),
      'must not suggest a maxmemory change',
    )
    assert(
      restated.message.includes('MISCONF Errors writing to the RDB snapshots.'),
      'should keep the raw server error',
    )
  })

  it('leaves every other error exactly as the server sent it', () => {
    for (const message of [
      'ERR unknown command RESTORE',
      'BUSYKEY Target key name already exists.',
      'DUMP payload version or checksum are wrong',
    ]) {
      const original = new Error(message)
      assertEqual(
        describeTargetWriteFailure(original),
        original,
        `${message} must pass through untouched`,
      )
    }
  })
})

describe('an out-of-memory target is not a fallback case', () => {
  it('never switches strategy on OOM', () => {
    // Both strategies write to the same server. Falling back to the logical
    // walk would just reach the same ceiling more slowly, and would report the
    // wrong cause on the way.
    assertEqual(
      shouldFallBackToLogicalCopy(OOM_REPLY),
      false,
      'OOM must not trigger a strategy switch',
    )
    assertEqual(
      shouldFallBackToLogicalCopy('MISCONF Errors writing to the RDB'),
      false,
      'MISCONF must not trigger a strategy switch',
    )
  })

  it('still falls back for the format refusals it is meant for', () => {
    assertEqual(
      shouldFallBackToLogicalCopy('DUMP payload version or checksum are wrong'),
      true,
      'a payload-format refusal still falls back',
    )
    assertEqual(
      shouldFallBackToLogicalCopy('unknown command DUMP'),
      true,
      'an unimplemented DUMP still falls back',
    )
  })
})
