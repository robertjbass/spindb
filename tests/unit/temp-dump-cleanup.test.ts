import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  getPendingTempDumps,
  registerTempDump,
  releaseTempDump,
} from '../../core/temp-dump-cleanup'
import { assert, assertEqual } from '../utils/assertions'

const FIXTURE = resolve(
  import.meta.dirname,
  '../fixtures/temp-dump-cleanup/terminated-dump.ts',
)

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

describe('temp dump cleanup registration', () => {
  it('tracks a registered path and forgets a released one', () => {
    const path = join(tmpdir(), `spindb-dump-registry-${Date.now()}.dump`)

    registerTempDump(path)
    assert(
      getPendingTempDumps().includes(path),
      'a registered temp dump must be removed on termination',
    )

    releaseTempDump(path)
    assert(
      !getPendingTempDumps().includes(path),
      'a path the caller already deleted must not stay in the registry',
    )
  })

  it('returns a release callback so callers need not repeat the path', () => {
    const path = join(tmpdir(), `spindb-dump-release-${Date.now()}.dump`)

    const release = registerTempDump(path)
    release()

    assert(
      !getPendingTempDumps().includes(path),
      'the returned callback must release the same path',
    )
  })
})

describe('temp dump cleanup on SIGTERM', () => {
  it('removes the partial dump and kills the dump client', async () => {
    const dumpPath = join(tmpdir(), `spindb-dump-sigterm-${Date.now()}.dump`)

    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', FIXTURE, dumpPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    const exited = new Promise<{ code: number | null }>((res) => {
      proc.on('close', (code) => res({ code }))
    })

    try {
      const ready = await waitFor(() => stdout.includes('ready'), 30000)
      assert(ready, `fixture never became ready. stderr: ${stderr}`)
      assert(
        existsSync(dumpPath),
        'the fixture must write a partial dump first',
      )

      const childPid = Number(stdout.trim().split(' ')[1])
      assert(Number.isInteger(childPid), `no child pid in output: ${stdout}`)

      proc.kill('SIGTERM')
      const { code } = await exited

      assertEqual(
        code,
        143,
        'a terminated restore must exit with the conventional 128 + SIGTERM',
      )
      assert(
        !existsSync(dumpPath),
        'the partial temp dump must be removed when the process is terminated',
      )
      assert(
        await waitFor(() => !isAlive(childPid), 5000),
        'the dump client must be killed rather than orphaned',
      )
    } finally {
      if (!proc.killed) proc.kill('SIGKILL')
      rmSync(dumpPath, { force: true })
    }
  })
})
