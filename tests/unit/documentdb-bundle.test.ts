import type { ContainerConfig } from '../../types'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { getEngine, listEngines } from '../../engines'
import { platformService } from '../../core/platform-service'
import { supportsDocumentDBPlatform } from '../../engines/documentdb/binary-urls'
import { Arch, Engine, Platform } from '../../types'
import {
  DocumentDBNativeRuntime,
  verifyDocumentDBBundle,
} from '../../engines/documentdb/native-runtime'

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
  it('refuses a platform when the exact artifact is absent from the pinned HostDB snapshot', () => {
    assert.equal(
      supportsDocumentDBPlatform(Platform.Darwin, Arch.ARM64, '9.9.9'),
      false,
    )
  })
  it('offers standalone DocumentDB on Linux and macOS ARM64', (context) => {
    const original = platformService.getPlatformInfo()
    for (const arch of ['x64', 'arm64'] as const) {
      for (const platform of [
        Platform.Linux,
        Platform.Darwin,
        Platform.Win32,
      ]) {
        const mocked = context.mock.method(
          platformService,
          'getPlatformInfo',
          () => ({ ...original, platform, arch }),
        )
        try {
          assert.equal(
            listEngines().some((engine) => engine.name === Engine.DocumentDB),
            platform === Platform.Linux ||
              (platform === Platform.Darwin && arch === 'arm64'),
            `${platform}-${arch}`,
          )
        } finally {
          mocked.mock.restore()
        }
      }
    }
  })
})

it(
  'supports a Cloud UUID path without exceeding the private socket limit',
  { skip: process.platform !== 'linux' },
  () => {
    const runtime = new DocumentDBNativeRuntime({
      bundlePath: '/tmp/bundle',
      containerPath:
        '/home/layerbase/.spindb/containers/documentdb/cloud_00000000-0000-0000-0000-000000000000',
      version: '1.0.0',
      port: 27019,
    })
    assert.ok(Buffer.byteLength(runtime.socketPath) + 15 < 108)
  },
)

it('refuses database-scoped grants instead of silently granting global access', async () => {
  const engine = getEngine(Engine.DocumentDB)
  await assert.rejects(
    engine.createUser({ name: 'fixture', database: 'app' } as ContainerConfig, {
      username: 'fixture',
      password: 'not-a-real-secret',
      database: 'app',
    }),
    /requires --database admin/,
  )
})
