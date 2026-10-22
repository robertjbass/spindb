import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { listEngines } from '../../engines'
import { platformService } from '../../core/platform-service'
import { Engine, Platform } from '../../types'
import { verifyDocumentDBBundle } from '../../engines/documentdb/native-runtime'

describe('DocumentDB exact bundle validation', () => {
  it('refuses absent provenance instead of assigning the current default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docdb-pin-'))
    try {
      await assert.rejects(verifyDocumentDBBundle(root, '1.0.0'), /ENOENT/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses mixed versions and incomplete bundles before executing binaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docdb-pin-'))
    const metadata = {
      name: 'documentdb',
      version: '1.0.0',
      components: {
        documentdb: '1.0.0',
        gateway: '1.0.0',
        postgresql: '17.11',
      },
    }
    const write = async (value: unknown) =>
      writeFile(join(root, '.hostdb-metadata.json'), JSON.stringify(value))
    try {
      await write({ ...metadata, version: '2.0.0' })
      await assert.rejects(
        verifyDocumentDBBundle(root, '1.0.0'),
        /metadata does not match/,
      )
      await write({
        ...metadata,
        components: { ...metadata.components, gateway: '0.1.0' },
      })
      await assert.rejects(
        verifyDocumentDBBundle(root, '1.0.0'),
        /metadata does not match/,
      )
      await write(metadata)
      await mkdir(join(root, 'bin'))
      await assert.rejects(
        verifyDocumentDBBundle(root, '1.0.0'),
        /missing postgres/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('DocumentDB platform discovery', () => {
  it('offers standalone DocumentDB only on qualified Linux platforms', (context) => {
    const original = platformService.getPlatformInfo()
    for (const platform of [Platform.Linux, Platform.Darwin, Platform.Win32]) {
      const mocked = context.mock.method(
        platformService,
        'getPlatformInfo',
        () => ({ ...original, platform }),
      )
      try {
        assert.equal(
          listEngines().some((engine) => engine.name === Engine.DocumentDB),
          platform === Platform.Linux,
        )
      } finally {
        mocked.mock.restore()
      }
    }
  })
})
