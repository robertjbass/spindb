import { describe, it, before, after, afterEach } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { paths } from '../../config/paths'
// Loads the engine registry first, as the CLI does.
import '../../core/container-manager'
import { postgresqlEngine } from '../../engines/postgresql'
import { postgresqlBinaryManager } from '../../engines/postgresql/binary-manager'
import { Platform, type Arch } from '../../types'
import { assert, assertDeepEqual, assertEqual } from '../utils/assertions'

const realBin = paths.bin
const realGetBinaryPath = paths.getBinaryPath.bind(paths)
const realDownload = postgresqlBinaryManager.download.bind(
  postgresqlBinaryManager,
)

describe('PostgreSQL binary refresh', () => {
  let root: string
  const platform = Platform.Linux
  const arch = 'x64' as Arch

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'spindb-pg-refresh-test-'))
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  afterEach(async () => {
    paths.bin = realBin
    paths.getBinaryPath = realGetBinaryPath
    postgresqlBinaryManager.download = realDownload
    await rm(join(root, 'bin'), { recursive: true, force: true })
  })

  function binPath(version: string): string {
    return join(root, 'bin', `postgresql-${version}-linux-x64`)
  }

  async function installCached(version: string, marker: string) {
    await mkdir(join(binPath(version), 'bin'), { recursive: true })
    await writeFile(join(binPath(version), 'bin', 'postgres'), marker)
  }

  function stubDownload(behavior: 'succeed' | 'fail'): string[] {
    paths.bin = join(root, 'bin')
    paths.getBinaryPath = (options) => binPath(options.version)
    const calls: string[] = []
    postgresqlBinaryManager.download = async (version: string) => {
      calls.push(version)
      // Like the real download: the target must be gone before extracting.
      assert(!existsSync(binPath(version)), 'cached copy moved aside first')
      await mkdir(join(binPath(version), 'bin'), { recursive: true })
      await writeFile(join(binPath(version), 'bin', 'postgres'), 'partial')
      if (behavior === 'fail') {
        await rm(binPath(version), { recursive: true, force: true })
        throw new Error('download failed')
      }
      await writeFile(join(binPath(version), 'bin', 'postgres'), 'fresh')
      return binPath(version)
    }
    return calls
  }

  it('replaces a cached version with a fresh download and removes the old copy', async () => {
    await installCached('18.6.0', 'stale')
    const calls = stubDownload('succeed')

    const result = await postgresqlBinaryManager.refresh(
      '18.6.0',
      platform,
      arch,
    )

    assertEqual(result, binPath('18.6.0'), 'same cache path')
    assertDeepEqual(calls, ['18.6.0'], 'downloaded the same version')
    assertEqual(
      await readFile(join(binPath('18.6.0'), 'bin', 'postgres'), 'utf8'),
      'fresh',
      'fresh build in place',
    )
    assertDeepEqual(
      await readdir(join(root, 'bin')),
      ['postgresql-18.6.0-linux-x64'],
      'no leftover copy',
    )
  })

  it('puts the cached copy back when the download fails', async () => {
    await installCached('18.6.0', 'stale')
    stubDownload('fail')

    let error: unknown
    try {
      await postgresqlBinaryManager.refresh('18.6.0', platform, arch)
    } catch (caught) {
      error = caught
    }

    assert(error instanceof Error, 'refresh rethrows the failure')
    assertEqual(
      await readFile(join(binPath('18.6.0'), 'bin', 'postgres'), 'utf8'),
      'stale',
      'cached copy restored',
    )
    assertDeepEqual(
      await readdir(join(root, 'bin')),
      ['postgresql-18.6.0-linux-x64'],
      'no leftover copy',
    )
  })

  it('downloads a version that is not cached yet', async () => {
    const calls = stubDownload('succeed')
    await mkdir(join(root, 'bin'), { recursive: true })

    await postgresqlBinaryManager.refresh('18.6.0', platform, arch)

    assertDeepEqual(calls, ['18.6.0'], 'downloaded')
  })
})

describe('PostgreSQL offered versions', () => {
  it('never offers a legacy -cron.N build revision', async () => {
    const versions = await postgresqlEngine.fetchAvailableVersions()
    const all = Object.values(versions).flat()
    assert(all.length > 0, 'versions are offered')
    assert(
      all.every((version) => !/-cron\.\d+$/.test(version)),
      `no -cron.N revision offered: ${all.join(', ')}`,
    )
    assert(all.includes('18.6.0'), 'standard 18.6.0 is offered')
  })
})
