import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../../config/paths'
import { processManager } from '../../core/process-manager'

afterEach(() => mock.restoreAll())

for (const value of ['-1', '0', '123oops', '', '1.5']) {
  test(`strict PID lookup refuses invalid value ${JSON.stringify(value)}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spindb-strict-pid-'))
    try {
      const path = join(dir, 'postmaster.pid')
      await writeFile(path, value)
      mock.method(paths, 'getContainerPidPath', () => path)
      await assert.rejects(
        processManager.getPid('source', { engine: 'postgresql', strict: true }),
        /Invalid server PID/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('strict PID lookup returns null only for a missing file, and propagates read errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spindb-strict-pid-'))
  try {
    mock.method(paths, 'getContainerPidPath', () => join(dir, 'missing'))
    assert.equal(
      await processManager.getPid('source', {
        engine: 'postgresql',
        strict: true,
      }),
      null,
    )
    mock.method(paths, 'getContainerPidPath', () => dir)
    await assert.rejects(
      processManager.getPid('source', { engine: 'postgresql', strict: true }),
    )
    const path = join(dir, 'postmaster.pid')
    await writeFile(path, '12345\n/data\n')
    mock.method(paths, 'getContainerPidPath', () => path)
    assert.equal(
      await processManager.getPid('source', {
        engine: 'postgresql',
        strict: true,
      }),
      12345,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
