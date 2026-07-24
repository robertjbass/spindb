import { after, afterEach, before, describe, it, mock } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { paths } from '../../config/paths'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { DuckDBEngine } from '../../engines/duckdb/index'
import { SQLiteEngine } from '../../engines/sqlite/index'
import { assertEqual, assertNullish } from '../utils/assertions'

describe('file-based binary version resolution', () => {
  let tempRoot: string

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'spindb-file-binary-test-'))
  })

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  afterEach(async () => {
    mock.restoreAll()
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = await mkdtemp(join(tmpdir(), 'spindb-file-binary-test-'))
  })

  async function createBinary(
    installName: string,
    executableName: string,
  ): Promise<{ installPath: string; executablePath: string }> {
    const installPath = join(tempRoot, installName)
    const executablePath = join(
      installPath,
      'bin',
      `${executableName}${platformService.getExecutableExtension()}`,
    )
    await mkdir(join(installPath, 'bin'), { recursive: true })
    await writeFile(executablePath, 'test binary')
    return { installPath, executablePath }
  }

  it('uses the exact requested DuckDB install instead of a stale cached path', async () => {
    const stale = await createBinary('duckdb-1.4.3', 'duckdb')
    const requested = await createBinary('duckdb-1.5.5', 'duckdb')

    mock.method(
      configManager,
      'getBinaryPath',
      async () => stale.executablePath,
    )
    mock.method(paths, 'getBinaryPath', () => requested.installPath)

    const engine = new DuckDBEngine()
    assertEqual(
      await engine.getDuckDBPath('1.5'),
      requested.executablePath,
      'Versioned lookup should use the requested DuckDB install',
    )
    assertEqual(
      await engine.getDuckDBPath(),
      stale.executablePath,
      'Versionless lookup should preserve the cached-path behavior',
    )
  })

  it('does not satisfy a missing DuckDB version with a stale cached path', async () => {
    const stale = await createBinary('duckdb-1.4.3', 'duckdb')
    const missingInstall = join(tempRoot, 'duckdb-1.5.5-missing')

    mock.method(
      configManager,
      'getBinaryPath',
      async () => stale.executablePath,
    )
    mock.method(paths, 'getBinaryPath', () => missingInstall)

    const engine = new DuckDBEngine()
    assertNullish(
      await engine.getDuckDBPath('1.5'),
      'Missing requested DuckDB version should return null',
    )
  })

  it('uses the exact requested SQLite install instead of a stale cached path', async () => {
    const stale = await createBinary('sqlite-3.49.0', 'sqlite3')
    const requested = await createBinary('sqlite-3.51.2', 'sqlite3')

    mock.method(
      configManager,
      'getBinaryPath',
      async () => stale.executablePath,
    )
    mock.method(paths, 'getBinaryPath', () => requested.installPath)

    const engine = new SQLiteEngine()
    assertEqual(
      await engine.getSqlite3Path('3'),
      requested.executablePath,
      'Versioned lookup should use the requested SQLite install',
    )
    assertEqual(
      await engine.getSqlite3Path(),
      stale.executablePath,
      'Versionless lookup should preserve the cached-path behavior',
    )
  })

  it('does not satisfy a missing SQLite version with a stale cached path', async () => {
    const stale = await createBinary('sqlite-3.49.0', 'sqlite3')
    const missingInstall = join(tempRoot, 'sqlite-3.51.2-missing')

    mock.method(
      configManager,
      'getBinaryPath',
      async () => stale.executablePath,
    )
    mock.method(paths, 'getBinaryPath', () => missingInstall)

    const engine = new SQLiteEngine()
    assertNullish(
      await engine.getSqlite3Path('3'),
      'Missing requested SQLite version should return null',
    )
  })
})
