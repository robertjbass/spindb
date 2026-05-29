import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { cloneDirectory, detectCowSupport } from '../../core/cow-copy'

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
