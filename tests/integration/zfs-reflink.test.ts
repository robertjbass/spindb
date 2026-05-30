import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { cloneDirectory } from '../../core/cow-copy'

// Reflink guard. `cloneDirectory` (what `spindb branch` calls) MUST reflink on a
// reflink-capable filesystem, not silently full-copy. The entire Layerbase
// cloud branching cost model depends on this returning "reflink" on ZFS, so a
// regression here — a future change that drops `--reflink=always`, mishandles
// the fallback, or a ZFS/OpenZFS issue that loses block cloning — has to fail
// CI loudly.
//
// This runs ONLY when SPINDB_ZFS_TEST_DIR points at a real ZFS mount, which the
// .github/workflows/zfs-reflink.yml job sets up on a throwaway file-backed
// zpool. On a normal ext4 runner the suite skips (ext4 has no reflink — the
// generic cow-copy.test.ts already covers the copy-fallback path there).
const ZFS_DIR = process.env.SPINDB_ZFS_TEST_DIR

describe(
  'cow-copy: reflink guarantee on a reflink-capable FS (ZFS)',
  { skip: ZFS_DIR ? false : 'SPINDB_ZFS_TEST_DIR not set — ZFS-only guard' },
  () => {
    it('cloneDirectory reports method "reflink" and the clone is independent', async () => {
      const base = await mkdtemp(join(ZFS_DIR as string, 'spindb-zfs-'))
      const src = join(base, 'src')
      const dst = join(base, 'dst')
      await mkdir(src, { recursive: true })
      // A few MB so a reflink is meaningfully cheaper than a byte copy.
      await writeFile(join(src, 'data.bin'), Buffer.alloc(8 * 1024 * 1024, 7))
      await writeFile(join(src, 'marker.txt'), 'parent')

      const result = await cloneDirectory(src, dst)

      assert.equal(
        result.method,
        'reflink',
        `expected "reflink" on ZFS, got "${result.method}" — the cp --reflink=always ` +
          'path regressed, or this filesystem/OpenZFS version lost block cloning. ' +
          'Layerbase cloud branching depends on this.',
      )
      // Content copied through.
      assert.equal(await readFile(join(dst, 'marker.txt'), 'utf8'), 'parent')
      // Copy-on-write independence: writing the clone must not touch the source.
      await writeFile(join(dst, 'marker.txt'), 'branch')
      assert.equal(await readFile(join(src, 'marker.txt'), 'utf8'), 'parent')
    })
  },
)
