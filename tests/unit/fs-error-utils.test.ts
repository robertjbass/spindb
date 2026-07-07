/**
 * fs-error-utils unit tests
 *
 * Focus: ensureExecutable must be a no-op against an already-correct
 * read-only binary store (Layerbase cloud mounts a shared store read-only
 * at ~/.spindb/bin, where an unconditional chmod throws EROFS even when
 * the file is already 0o755).
 */

import { describe, it, before, after } from 'node:test'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdir, rm, writeFile } from 'fs/promises'
import { assert, assertEqual } from '../utils/assertions'
import { ensureExecutable } from '../../core/fs-error-utils'

function makeFsError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe('ensureExecutable', () => {
  const testDir = join(tmpdir(), `fs-error-utils-test-${Date.now()}`)

  before(async () => {
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  // All mode/exec-bit behavior is exercised through the injectable statFn/
  // chmodFn/accessFn rather than the real filesystem: Windows has no POSIX
  // exec bits (stat never reports 0o755 and access(X_OK) always passes), so
  // real-fs assertions fail on the win32 CI runner while the injected paths
  // behave identically on every platform.
  it('does not call chmod when exec bits are already set', async () => {
    const filePath = join(testDir, 'already-exec.sh')
    await writeFile(filePath, '#!/bin/sh\n')

    let chmodCalled = false
    await ensureExecutable(filePath, {
      statFn: async () => ({ mode: 0o755 }),
      chmodFn: async () => {
        chmodCalled = true
        throw makeFsError('EROFS', 'read-only file system')
      },
    })

    assertEqual(chmodCalled, false, 'chmod must not run on a 0o755 file')
  })

  it('applies chmod when exec bits are missing on a writable fs', async () => {
    const filePath = join(testDir, 'not-exec.sh')
    await writeFile(filePath, '#!/bin/sh\n')

    let appliedMode: number | null = null
    await ensureExecutable(filePath, {
      statFn: async () => ({ mode: 0o644 }),
      chmodFn: async (_path, mode) => {
        appliedMode = mode
      },
    })

    assertEqual(
      appliedMode,
      0o755,
      'chmod must be invoked with 0o755 when exec bits are missing',
    )
  })

  it('tolerates EROFS from chmod when the file is already executable', async () => {
    // Simulates the read-only shared-store case: stat initially reports
    // missing exec bits (e.g. group/other), chmod throws EROFS, but the
    // access(X_OK) confirmation shows the file is executable for us.
    const filePath = join(testDir, 'ro-store.sh')
    await writeFile(filePath, '#!/bin/sh\n')

    let threw = false
    try {
      await ensureExecutable(filePath, {
        // Report owner-exec only so the chmod path is exercised
        statFn: async () => ({ mode: 0o700 }),
        chmodFn: async () => {
          throw makeFsError('EROFS', 'read-only file system')
        },
        // access(X_OK) confirms the file is executable for us
        accessFn: async () => {},
      })
    } catch {
      threw = true
    }

    assertEqual(
      threw,
      false,
      'EROFS must be tolerated when the file is already executable',
    )
  })

  it('tolerates EPERM from chmod when the file is already executable', async () => {
    const filePath = join(testDir, 'eperm-store.sh')
    await writeFile(filePath, '#!/bin/sh\n')

    let threw = false
    try {
      await ensureExecutable(filePath, {
        statFn: async () => ({ mode: 0o700 }),
        chmodFn: async () => {
          throw makeFsError('EPERM', 'operation not permitted')
        },
        accessFn: async () => {},
      })
    } catch {
      threw = true
    }

    assertEqual(
      threw,
      false,
      'EPERM must be tolerated when the file is already executable',
    )
  })

  it('rethrows EROFS when the file is NOT executable', async () => {
    const filePath = join(testDir, 'broken-store.sh')
    await writeFile(filePath, '#!/bin/sh\n')

    let caught: NodeJS.ErrnoException | null = null
    try {
      await ensureExecutable(filePath, {
        statFn: async () => ({ mode: 0o644 }),
        chmodFn: async () => {
          throw makeFsError('EROFS', 'read-only file system')
        },
        accessFn: async () => {
          throw makeFsError('EACCES', 'permission denied')
        },
      })
    } catch (error) {
      caught = error as NodeJS.ErrnoException
    }

    assert(
      caught !== null,
      'EROFS must be rethrown when the file is not executable',
    )
    assertEqual(caught.code, 'EROFS', 'original error must be preserved')
  })

  it('rethrows unrelated chmod errors immediately', async () => {
    const filePath = join(testDir, 'enoent-like.sh')
    await writeFile(filePath, '#!/bin/sh\n')

    let caught: NodeJS.ErrnoException | null = null
    try {
      await ensureExecutable(filePath, {
        statFn: async () => ({ mode: 0o644 }),
        chmodFn: async () => {
          throw makeFsError('EIO', 'i/o error')
        },
      })
    } catch (error) {
      caught = error as NodeJS.ErrnoException
    }

    assert(caught !== null, 'non-permission errors must be rethrown')
    assertEqual(caught.code, 'EIO', 'original error must be preserved')
  })
})
