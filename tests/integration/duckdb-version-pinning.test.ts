import { it } from 'node:test'
import assert from 'node:assert/strict'
import { constants, existsSync } from 'fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'

const execFileAsync = promisify(execFile)
const repo = fileURLToPath(new URL('../..', import.meta.url))
const oldVersion = '1.4.3'
const newVersion = '1.5.5'
const { platform, arch } = platformService.getPlatformInfo()
const executable = `duckdb${platformService.getExecutableExtension()}`
const installs = [oldVersion, newVersion].map((version) => ({
  version,
  directory: `duckdb-${version}-${platform}-${arch}`,
  binary: join(
    paths.bin,
    `duckdb-${version}-${platform}-${arch}`,
    'bin',
    executable,
  ),
}))

it(
  'preserves DuckDB versions across CLI invocations, branches and restores',
  {
    skip:
      process.env.CI || installs.every(({ binary }) => existsSync(binary))
        ? false
        : `Install DuckDB ${oldVersion} and ${newVersion} to run the version preservation drill`,
    timeout: 300_000,
  },
  async () => {
    for (const { version, binary } of installs) {
      assert.ok(
        existsSync(binary),
        `Missing DuckDB ${version}. Run spindb engines download duckdb ${version}`,
      )
    }
    const root = await mkdtemp(join(tmpdir(), 'spindb-duckdb-version-drill-'))
    try {
      for (const install of installs) {
        const target = join(root, 'bin', install.directory, 'bin', executable)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(install.binary, target, constants.COPYFILE_FICLONE)
      }
      const preferred = join(
        root,
        'bin',
        installs[1].directory,
        'bin',
        executable,
      )
      await writeConfigWithPreferredBinary()

      async function writeConfigWithPreferredBinary(): Promise<void> {
        const configPath = join(root, 'config.json')
        const config = existsSync(configPath)
          ? JSON.parse(await readFile(configPath, 'utf8'))
          : {}
        config.binaries = {
          ...config.binaries,
          duckdb: {
            tool: 'duckdb',
            path: preferred,
            source: 'bundled',
            version: newVersion,
          },
        }
        await writeFile(configPath, JSON.stringify(config))
      }

      async function cli(...args: string[]): Promise<Record<string, unknown>> {
        const { stdout } = await execFileAsync(
          process.execPath,
          ['--import', 'tsx', 'cli/bin.ts', ...args, '--json'],
          {
            cwd: repo,
            env: { ...process.env, SPINDB_HOME: root },
            timeout: 60_000,
          },
        )
        return JSON.parse(stdout)
      }

      async function assertRuntime(
        name: string,
        version: string,
      ): Promise<void> {
        const result = await cli(
          'query',
          name,
          'SELECT version() AS runtime_version',
        )
        assert.match(
          JSON.stringify(result),
          new RegExp(`v${version.replaceAll('.', '\\.')}`),
        )
        assert.equal((await cli('info', name)).version, version)
      }

      await cli(
        'create',
        'old',
        '--engine',
        'duckdb',
        '--db-version',
        oldVersion,
      )
      await cli(
        'create',
        'new',
        '--engine',
        'duckdb',
        '--db-version',
        newVersion,
      )
      await writeConfigWithPreferredBinary()
      await assertRuntime('old', oldVersion)
      await assertRuntime('new', newVersion)
      await cli('query', 'old', 'CREATE TABLE kept AS SELECT 42 AS value')
      await cli('branch', 'old', 'child')
      await assertRuntime('child', oldVersion)
      assert.match(
        JSON.stringify(await cli('query', 'child', 'SELECT * FROM kept')),
        /42/,
      )

      const backup = await cli(
        'backup',
        'old',
        '--output',
        root,
        '--name',
        'saved',
        '--format',
        'sql',
      )
      assert.equal(backup.success, true)
      await cli(
        'create',
        'restored',
        '--engine',
        'duckdb',
        '--db-version',
        oldVersion,
        '--from',
        join(root, 'saved.sql'),
      )
      await assertRuntime('restored', oldVersion)
      assert.match(
        JSON.stringify(await cli('query', 'restored', 'SELECT * FROM kept')),
        /42/,
      )

      const binaryBackup = await cli(
        'backup',
        'old',
        '--output',
        root,
        '--name',
        'saved-binary',
        '--format',
        'binary',
      )
      assert.equal(binaryBackup.success, true)
      assert.equal(typeof binaryBackup.path, 'string')
      await cli(
        'create',
        'binary-restored',
        '--engine',
        'duckdb',
        '--db-version',
        oldVersion,
        '--from',
        String(binaryBackup.path),
      )
      await assertRuntime('binary-restored', oldVersion)
      assert.match(
        JSON.stringify(
          await cli('query', 'binary-restored', 'SELECT * FROM kept'),
        ),
        /42/,
      )

      const oldInstall = join(root, 'bin', installs[0].directory)
      await rename(oldInstall, `${oldInstall}-unavailable`)
      await assert.rejects(
        () => cli('query', 'old', 'SELECT 1'),
        (error: unknown) => {
          assert.ok(
            error &&
              typeof error === 'object' &&
              'stdout' in error &&
              'code' in error,
          )
          assert.equal(error.code, 1)
          assert.match(String(error.stdout), /duckdb.*not found/i)
          assert.match(
            String(error.stdout),
            /spindb engines download duckdb 1\.4\.3/,
          )
          return true
        },
      )
      await assertRuntime('new', newVersion)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
