/**
 * Tests for surfacing the PostgreSQL server log FATAL reason when pg_ctl
 * start fails.
 */

import { describe, it } from 'node:test'
import { appendFile, chmod, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  extractPostgresFatal,
  getLogFileSize,
  processManager,
  readPostgresStartFailure,
} from '../../core/process-manager'
import { isWindows } from '../../core/platform-service'
import { assert, assertEqual } from '../utils/assertions'

const PRELOAD_FATAL =
  '2026-09-27 10:00:00.000 UTC [123] FATAL:  could not access file "auto_explain,pg_stat_statements": No such file or directory'

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'spindb-pglog-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('extractPostgresFatal', () => {
  it('returns null when there is no FATAL or PANIC line', () => {
    assertEqual(
      extractPostgresFatal('LOG:  database system is ready\n'),
      null,
      'no fatal',
    )
  })

  it('returns the most recent FATAL with its DETAIL and HINT lines', () => {
    const text = [
      'FATAL:  old failure',
      'LOG:  starting PostgreSQL',
      'FATAL:  lock file "postmaster.pid" already exists',
      'HINT:  Is another postmaster (PID 42) running?',
      'LOG:  database system is shut down',
    ].join('\n')
    assertEqual(
      extractPostgresFatal(text),
      'FATAL:  lock file "postmaster.pid" already exists\nHINT:  Is another postmaster (PID 42) running?',
      'latest entry with hint',
    )
  })

  it('picks up PANIC lines', () => {
    assertEqual(
      extractPostgresFatal(
        'PANIC:  could not locate a valid checkpoint record',
      ),
      'PANIC:  could not locate a valid checkpoint record',
      'panic',
    )
  })
})

describe('readPostgresStartFailure', () => {
  it('never throws on a missing file', async () => {
    assertEqual(
      await readPostgresStartFailure('/nonexistent/spindb/pg.log', 0),
      null,
      'missing file',
    )
    assertEqual(await getLogFileSize('/nonexistent/spindb/pg.log'), 0, 'size')
  })

  it('only reports FATAL lines written after the offset', async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, 'pg.log')
      await writeFile(log, 'FATAL:  stale failure from an earlier start\n')
      const offset = await getLogFileSize(log)
      await appendFile(log, `LOG:  starting\n${PRELOAD_FATAL}\n`)
      const result = await readPostgresStartFailure(log, offset)
      assert(result !== null && result.includes('auto_explain'), 'fresh fatal')
      assert(!result.includes('stale'), 'stale entry ignored')
    })
  })

  it('falls back to the last FATAL when nothing new was written', async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, 'pg.log')
      await writeFile(log, `${PRELOAD_FATAL}\n`)
      const offset = await getLogFileSize(log)
      const result = await readPostgresStartFailure(log, offset)
      assert(result !== null && result.includes('auto_explain'), 'fallback')
    })
  })

  it('reads only a bounded tail of a large log', async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, 'pg.log')
      const filler = 'LOG:  checkpoint complete\n'.repeat(10000)
      await writeFile(log, `FATAL:  ancient\n${filler}${PRELOAD_FATAL}\n`)
      const result = await readPostgresStartFailure(log, 0)
      assert(result !== null && result.includes('auto_explain'), 'tail fatal')
    })
  })
})

describe('processManager.start failure message', () => {
  it('appends the log FATAL reason to the pg_ctl error', async (t) => {
    if (isWindows()) {
      t.skip('fake pg_ctl is a shell script')
      return
    }
    await withTempDir(async (dir) => {
      const log = join(dir, 'pg.log')
      await writeFile(log, 'FATAL:  stale failure\n')
      const fakePgCtl = join(dir, 'pg_ctl')
      await writeFile(
        fakePgCtl,
        [
          '#!/bin/sh',
          `echo '${PRELOAD_FATAL}' >> "${log}"`,
          'echo "pg_ctl: could not start server" >&2',
          'echo "Examine the log output." >&2',
          'exit 1',
        ].join('\n'),
      )
      await chmod(fakePgCtl, 0o755)
      let message = ''
      try {
        await processManager.start(fakePgCtl, dir, { logFile: log, port: 1 })
      } catch (error) {
        message = (error as Error).message
      }
      assert(
        message.startsWith(
          'pg_ctl start failed with code 1: pg_ctl: could not start server',
        ),
        `prefix kept: ${message}`,
      )
      assert(
        message.includes(`\nPostgreSQL log: ${PRELOAD_FATAL}`),
        `log reason appended: ${message}`,
      )
      assert(!message.includes('stale'), 'stale entry ignored')
    })
  })
})
