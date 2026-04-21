import { describe, it, before, after, afterEach } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'
import {
  getBundledBinaryPath,
  findCompatibleVersion,
  detectInstalledPostgres,
} from '../../core/pg-binary-resolver'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

// Save the real paths methods so we can restore them between tests.
const realFindInstalledBinaries = paths.findInstalledBinaries.bind(paths)
const realFindInstalledBinaryForMajor =
  paths.findInstalledBinaryForMajor.bind(paths)

type BinaryEntry = { version: string; path: string }

function stubInstalledBinaries(entries: BinaryEntry[]): void {
  paths.findInstalledBinaries = () => entries
  paths.findInstalledBinaryForMajor = (_engine, majorVersion) => {
    const majorPrefix = `${majorVersion}.`
    for (const entry of entries) {
      if (
        entry.version.startsWith(majorPrefix) ||
        entry.version === majorVersion
      ) {
        return entry
      }
    }
    return null
  }
}

function restorePaths(): void {
  paths.findInstalledBinaries = realFindInstalledBinaries
  paths.findInstalledBinaryForMajor = realFindInstalledBinaryForMajor
}

describe('getBundledBinaryPath', () => {
  let tempRoot: string
  let ext: string

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'spindb-bundled-test-'))
    ext = platformService.getExecutableExtension()
  })

  after(async () => {
    try {
      await rm(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  afterEach(() => {
    restorePaths()
  })

  it('returns the path to the bundled tool when the binary exists on disk', async () => {
    const { platform, arch } = platformService.getPlatformInfo()
    const installDir = join(tempRoot, `postgresql-18.1.0-${platform}-${arch}`)
    const binDir = join(installDir, 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, `pg_dump${ext}`), 'fake pg_dump')

    stubInstalledBinaries([{ version: '18.1.0', path: installDir }])

    const result = getBundledBinaryPath('pg_dump', '18')
    assertEqual(
      result,
      join(binDir, `pg_dump${ext}`),
      'Should return the bundled pg_dump path',
    )
  })

  it('returns null when no bundled install matches the requested major', () => {
    stubInstalledBinaries([
      { version: '17.7.0', path: '/nonexistent/postgresql-17' },
    ])

    const result = getBundledBinaryPath('pg_dump', '18')
    assertNullish(
      result,
      'Should return null when no matching major is installed',
    )
  })

  it('returns null when the install dir exists but the tool binary is missing', async () => {
    const { platform, arch } = platformService.getPlatformInfo()
    const installDir = join(
      tempRoot,
      `postgresql-missing-19.0.0-${platform}-${arch}`,
    )
    await mkdir(join(installDir, 'bin'), { recursive: true })

    stubInstalledBinaries([{ version: '19.0.0', path: installDir }])

    const result = getBundledBinaryPath('pg_restore', '19')
    assertNullish(
      result,
      'Should return null when the specific tool binary is missing',
    )
  })

  it('falls back to an older same-major install when the newest one is missing the tool', async () => {
    const { platform, arch } = platformService.getPlatformInfo()

    // Simulate a partial/corrupt pg 18.2 install — bin dir exists but pg_dump was never extracted.
    const broken = join(tempRoot, `postgresql-18.2.0-${platform}-${arch}`)
    await mkdir(join(broken, 'bin'), { recursive: true })

    // A healthy older pg 18.1 install that does contain pg_dump.
    const healthy = join(tempRoot, `postgresql-18.1.0-${platform}-${arch}`)
    const healthyBinDir = join(healthy, 'bin')
    await mkdir(healthyBinDir, { recursive: true })
    await writeFile(join(healthyBinDir, `pg_dump${ext}`), 'fake pg_dump')

    // findInstalledBinaries is sorted newest-first, so the broken install comes first.
    stubInstalledBinaries([
      { version: '18.2.0', path: broken },
      { version: '18.1.0', path: healthy },
    ])

    const result = getBundledBinaryPath('pg_dump', '18')
    assertEqual(
      result,
      join(healthyBinDir, `pg_dump${ext}`),
      'Should iterate past the broken install and return the healthy one',
    )
  })
})

describe('findCompatibleVersion', () => {
  let tempRoot: string
  let ext: string

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'spindb-compat-test-'))
    ext = platformService.getExecutableExtension()
  })

  after(async () => {
    try {
      await rm(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  afterEach(() => {
    restorePaths()
  })

  async function createBundledInstall(version: string): Promise<BinaryEntry> {
    const { platform, arch } = platformService.getPlatformInfo()
    const installDir = join(
      tempRoot,
      `postgresql-${version}-${platform}-${arch}`,
    )
    const binDir = join(installDir, 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, `pg_dump${ext}`), 'fake pg_dump')
    return { version, path: installDir }
  }

  it('picks the lowest compatible bundled version for the remote server', async () => {
    const pg17 = await createBundledInstall('17.7.0')
    const pg18 = await createBundledInstall('18.1.0')
    const pg19 = await createBundledInstall('19.0.0')

    stubInstalledBinaries([pg19, pg18, pg17])

    const result = findCompatibleVersion(18)
    assertEqual(
      result?.majorVersion,
      '18',
      'Should pick pg18 (lowest major >= 18) to read a pg18 remote',
    )
  })

  it('returns null when no bundled version is new enough for the remote', async () => {
    const pg17 = await createBundledInstall('17.7.0')
    stubInstalledBinaries([pg17])

    const result = findCompatibleVersion(18)
    assertNullish(
      result,
      'Should return null when the newest bundled major is older than the remote',
    )
  })

  it('never inspects Homebrew or APT-installed PostgreSQL', () => {
    // With no bundled binaries registered, the resolver must return nothing
    // regardless of what /opt/homebrew or /usr/lib/postgresql contains.
    stubInstalledBinaries([])
    const result = findCompatibleVersion(14)
    assertNullish(
      result,
      'Resolver must not fall back to system-installed PostgreSQL',
    )

    const all = detectInstalledPostgres()
    assertEqual(
      all.length,
      0,
      'detectInstalledPostgres must only list bundled binaries',
    )
  })
})

describe('no system-install remediation hints', () => {
  it('postgresql code paths never suggest brew install or apt install for PostgreSQL', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const repoRoot = resolve(here, '..', '..')

    const filesToCheck = [
      'core/pg-binary-resolver.ts',
      'engines/postgresql/version-validator.ts',
      'engines/postgresql/index.ts',
      'engines/postgresql/restore.ts',
      'engines/postgresql/backup.ts',
    ]

    for (const rel of filesToCheck) {
      const source = await readFile(join(repoRoot, rel), 'utf8')
      assert(
        !/brew install postgresql/.test(source),
        `${rel} must not tell users to \`brew install postgresql\` — use \`spindb engines download postgresql\``,
      )
      assert(
        !/apt install postgresql-client/.test(source),
        `${rel} must not tell users to \`apt install postgresql-client\` — use \`spindb engines download postgresql\``,
      )
    }
  })
})
