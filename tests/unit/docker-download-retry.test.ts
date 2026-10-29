import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function runDownload(options: { failures: number; status?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'download-retry-'))
  try {
    writeFileSync(
      join(dir, 'spindb'),
      `#!/bin/bash
n=$(cat "$FIXTURE/count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FIXTURE/count"
printf '%s\\n' "$*" >> "$FIXTURE/args"
if [ "$n" -le "$FAILURES" ]; then
  echo partial > "$FIXTURE/archive"
  echo terminated >&2
  exit "$FAILURE_STATUS"
fi
# A fresh download truncates the previous partial archive.
echo complete > "$FIXTURE/archive"
echo downloaded
`,
      { mode: 0o755 },
    )
    writeFileSync(
      join(dir, 'sleep'),
      '#!/bin/bash\necho "$1" >> "$FIXTURE/delays"\n',
      { mode: 0o755 },
    )
    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; download_with_retry mysql 8.4',
        'fixture',
        resolve('tests/docker/download-with-retry.sh'),
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          FIXTURE: dir,
          FAILURES: String(options.failures),
          FAILURE_STATUS: String(options.status ?? 1),
        },
      },
    )
    function read(name: string): string {
      try {
        return readFileSync(join(dir, name), 'utf8').trim()
      } catch {
        return ''
      }
    }
    return {
      ...result,
      attempts: Number(read('count')),
      args: read('args').split('\n'),
      delays: read('delays'),
      archive: read('archive'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe(
  'Docker download retry harness',
  { skip: process.platform === 'win32' },
  () => {
    test('download succeeds once without retrying', () => {
      const result = runDownload({ failures: 0 })
      assert.equal(result.status, 0)
      assert.equal(result.attempts, 1)
      assert.equal(result.delays, '')
    })

    test('transient failures retry the same download and replace partial output', () => {
      const result = runDownload({ failures: 2 })
      assert.equal(result.status, 0)
      assert.equal(result.attempts, 3)
      assert.deepEqual(result.args, Array(3).fill('engines download mysql 8.4'))
      assert.equal(result.delays, '2\n4')
      assert.equal(result.archive, 'complete')
      assert.match(result.stderr, /terminated/)
    })

    test('persistent failure preserves the exit status after three attempts', () => {
      const result = runDownload({ failures: 10, status: 7 })
      assert.equal(result.status, 7)
      assert.equal(result.attempts, 3)
      assert.equal(result.delays, '2\n4')
    })

    test('cancellation is never retried', () => {
      const result = runDownload({ failures: 10, status: 130 })
      assert.equal(result.status, 130)
      assert.equal(result.attempts, 1)
      assert.equal(result.delays, '')
    })
  },
)
