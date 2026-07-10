import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cloneDirectory,
  detectCowSupport,
  isTransientReflinkError,
} from '../../core/cow-copy'

describe('cow-copy: cloneDirectory', () => {
  it('clones a directory tree and reports a method', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spindb-cow-'))
    try {
      const src = join(base, 'src')
      const dst = join(base, 'dst')
      await mkdir(join(src, 'nested'), { recursive: true })
      await writeFile(join(src, 'a.txt'), 'hello')
      await writeFile(join(src, 'nested', 'b.txt'), 'world')

      const result = await cloneDirectory(src, dst)

      // method is FS-dependent (reflink on APFS/Btrfs/XFS-reflink/ZFS, copy on ext4/NTFS)
      assert.ok(
        result.method === 'reflink' || result.method === 'copy',
        `unexpected method: ${result.method}`,
      )
      assert.equal(typeof result.durationMs, 'number')
      assert.equal(await readFile(join(dst, 'a.txt'), 'utf8'), 'hello')
      assert.equal(
        await readFile(join(dst, 'nested', 'b.txt'), 'utf8'),
        'world',
      )
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('clones a single file', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spindb-cow-'))
    try {
      const src = join(base, 'a.db')
      const dst = join(base, 'b.db')
      await writeFile(src, 'data')

      const result = await cloneDirectory(src, dst)

      assert.ok(['reflink', 'copy'].includes(result.method))
      assert.equal(await readFile(dst, 'utf8'), 'data')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('falls back to a full copy on platforms without reflink (win32)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spindb-cow-'))
    try {
      const src = join(base, 'src')
      const dst = join(base, 'dst')
      await mkdir(src, { recursive: true })
      await writeFile(join(src, 'a.txt'), 'x')

      const result = await cloneDirectory(src, dst, { platform: 'win32' })

      assert.equal(result.method, 'copy')
      assert.equal(await readFile(join(dst, 'a.txt'), 'utf8'), 'x')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it(
    'skips socket entries instead of failing the full copy (e.g. a live PgBouncer .s.PGSQL)',
    {
      skip:
        process.platform === 'win32'
          ? 'unix domain sockets are POSIX-only'
          : false,
    },
    async () => {
      const { createServer } = await import('node:net')
      const { existsSync } = await import('node:fs')
      const base = await mkdtemp(join(tmpdir(), 'spindb-cow-'))
      const server = createServer()
      try {
        const src = join(base, 'src')
        const dst = join(base, 'dst')
        await mkdir(join(src, 'pgbouncer'), { recursive: true })
        await writeFile(join(src, 'base.db'), 'rows')
        // A live unix socket inside the data dir, mimicking pgbouncer's .s.PGSQL.
        const sock = join(src, 'pgbouncer', '.s.PGSQL')
        await new Promise<void>((resolve) => server.listen(sock, resolve))

        // Force the full-copy (deepCopy) path regardless of the host filesystem.
        const result = await cloneDirectory(src, dst, { platform: 'win32' })

        assert.equal(result.method, 'copy')
        // Regular file copies; the socket is skipped rather than throwing.
        assert.equal(await readFile(join(dst, 'base.db'), 'utf8'), 'rows')
        assert.equal(existsSync(join(dst, 'pgbouncer')), true)
        assert.equal(existsSync(join(dst, 'pgbouncer', '.s.PGSQL')), false)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(base, { recursive: true, force: true })
      }
    },
  )
})

describe('cow-copy: detectCowSupport', () => {
  it('returns a boolean for a real directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spindb-cow-'))
    try {
      const supported = await detectCowSupport(base)
      assert.equal(typeof supported, 'boolean')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('cow-copy: isTransientReflinkError (EAGAIN retry classifier)', () => {
  it('treats ZFS block-cloning EAGAIN as transient (so the reflink is retried)', () => {
    // The exact message `cp --reflink=always` prints when ZFS can't clone a
    // source whose blocks aren't in a committed txg yet.
    assert.equal(
      isTransientReflinkError(
        new Error(
          "cp: failed to clone 'dst' from 'src': Resource temporarily unavailable",
        ),
      ),
      true,
    )
    assert.equal(isTransientReflinkError(new Error('reflink: EAGAIN')), true)
  })

  it('reads EAGAIN off a subprocess error stderr field', () => {
    const err = Object.assign(new Error('cp exited with code 1'), {
      stderr: 'cp: failed to clone: Resource temporarily unavailable',
    })
    assert.equal(isTransientReflinkError(err), true)
  })

  it('treats no-reflink-support errors as permanent (fall straight back to copy)', () => {
    // ext4 / NTFS: `cp --reflink=always` fails with ENOTSUP, not EAGAIN —
    // retrying can never help, so this must NOT be classified as transient.
    assert.equal(
      isTransientReflinkError(
        new Error(
          "cp: failed to clone 'dst' from 'src': Operation not supported",
        ),
      ),
      false,
    )
    assert.equal(
      isTransientReflinkError(new Error('some other failure')),
      false,
    )
    assert.equal(isTransientReflinkError('plain string error'), false)
  })
})
