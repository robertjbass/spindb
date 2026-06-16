import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectBackupFormat as detectMongo } from '../../engines/mongodb/restore'
import { detectBackupFormat as detectFerret } from '../../engines/ferretdb/restore'

// Regression guard for the mongo<->ferret archive-plain restore bug: the
// mongodump archive magic 0x8199e26d (little-endian on disk: 6d e2 99 81) is an
// UNCOMPRESSED archive and must NOT be restored with --gzip. mongo previously
// classified it as 'unknown' and defaulted to --gzip, failing with
// "gzip: invalid header" on every archive-plain backup (its own AND FerretDB's,
// breaking cross-engine restore). The gzip magic (1f 8b) is the compressed case.
const ARCHIVE_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81, 0x10, 0x20, 0x30, 0x40])
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x11, 0x22, 0x33, 0x44])

describe('Mongo-wire uncompressed archive detection (archive-plain)', () => {
  const created: string[] = []
  let seq = 0

  after(async () => {
    await Promise.all(created.map((p) => rm(p, { force: true }).catch(() => {})))
  })

  async function fixture(label: string, buf: Buffer): Promise<string> {
    const p = join(tmpdir(), `mongo-archive-detect-${label}-${seq++}.archive`)
    await writeFile(p, buf)
    created.push(p)
    return p
  }

  for (const [name, detect] of [
    ['mongodb', detectMongo],
    ['ferretdb', detectFerret],
  ] as const) {
    it(`${name}: the mongodump archive magic is an UNCOMPRESSED archive (no --gzip)`, async () => {
      const fmt = await detect(await fixture(`${name}-plain`, ARCHIVE_MAGIC))
      assert.equal(
        fmt.format,
        'archive',
        'uncompressed archive magic should detect as archive',
      )
      assert.ok(
        !/--gzip/.test(fmt.restoreCommand),
        'an uncompressed archive must NOT restore with --gzip',
      )
    })

    it(`${name}: the gzip magic is a compressed archive (--gzip)`, async () => {
      const fmt = await detect(await fixture(`${name}-gz`, GZIP_MAGIC))
      assert.equal(
        fmt.format,
        'archive-gzip',
        'gzip magic should detect as archive-gzip',
      )
      assert.ok(
        /--gzip/.test(fmt.restoreCommand),
        'a gzipped archive restores with --gzip',
      )
    })
  }
})
