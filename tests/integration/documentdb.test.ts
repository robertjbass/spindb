import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import {
  mkdtemp,
  mkdir,
  symlink,
  readFile,
  writeFile,
  rename,
  rm,
} from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import net from 'net'
import { DocumentDBNativeRuntime } from '../../engines/documentdb/native-runtime'

const repository = fileURLToPath(new URL('../../', import.meta.url))

async function availablePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test(
  'DocumentDB CLI preserves documents and exact runtime pins through its lifecycle',
  {
    skip:
      process.platform !== 'linux' &&
      !(process.platform === 'darwin' && process.arch === 'arm64')
        ? 'Native DocumentDB requires Linux or macOS ARM64'
        : false,
    timeout: 600000,
  },
  async () => {
    // Darwin's per-user temp directory can exceed Unix socket limits once
    // container names are appended. Keep this isolated fixture path short.
    const home = await mkdtemp(
      join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'docdb-cli-'),
    )
    const env = { ...process.env, SPINDB_HOME: home }
    const platform = `${process.platform}-${process.arch}`
    const binaryPath = join(home, 'bin', `documentdb-1.0.0-${platform}`)
    let held = false
    let complete = false
    async function invoke(
      args: string[],
      input?: string,
    ): Promise<{ code: number | null; stdout: string }> {
      return new Promise((resolve, reject) => {
        const proc = spawn(
          process.execPath,
          [
            ...(process.env.DOCUMENTDB_TEST_CLI
              ? [process.env.DOCUMENTDB_TEST_CLI]
              : ['--import', 'tsx', 'cli/bin.ts']),
            ...args,
          ],
          {
            cwd: repository,
            env,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          },
        )
        if (input !== undefined) proc.stdin?.end(input)
        assert.ok(proc.stdout && proc.stderr)
        let stdout = ''
        const timer = setTimeout(() => {
          proc.kill('SIGTERM')
          reject(new Error(`${args[0]} exceeded its test timeout`))
        }, 120000)
        proc.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        // Do not echo credential-bearing client output into CI logs.
        proc.stderr.resume()
        proc.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        proc.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code, stdout })
        })
      })
    }
    async function cli(...args: string[]): Promise<Record<string, unknown>> {
      const result = await invoke([...args, '--json'])
      assert.equal(
        result.code,
        0,
        `${args[0]} failed; inspect the disposable fixture at ${home}`,
      )
      const output = JSON.parse(result.stdout) as Record<string, unknown>
      assert.notEqual(output.success, false, `${args[0]} returned failure`)
      return output
    }
    async function assertRow(name: string, value = 42): Promise<void> {
      const result = await cli(
        'query',
        name,
        'db.rows.find({_id:"persisted"}).toArray()',
      )
      assert.deepEqual(result.rows, [{ _id: 'persisted', value }])
    }
    async function assertPin(name: string): Promise<void> {
      const container = JSON.parse(
        await readFile(
          join(home, 'containers/documentdb', name, 'container.json'),
          'utf8',
        ),
      ) as { version: string }
      assert.equal(container.version, '1.0.0')
      const pin = JSON.parse(
        await readFile(
          join(
            home,
            'containers/documentdb',
            name,
            'data/.spindb-documentdb-runtime.json',
          ),
          'utf8',
        ),
      ) as { version: string }
      assert.equal(pin.version, '1.0.0')
    }
    try {
      await mkdir(join(home, 'bin'), { recursive: true })
      if (process.env.DOCUMENTDB_TEST_BUNDLE)
        await symlink(process.env.DOCUMENTDB_TEST_BUNDLE, binaryPath, 'dir')
      if (process.env.DOCUMENTDB_TEST_MONGODB_BUNDLE) {
        const mongodbVersion = process.env.DOCUMENTDB_TEST_MONGODB_VERSION
        assert.ok(
          mongodbVersion,
          'Provide the exact MongoDB client bundle version',
        )
        await symlink(
          process.env.DOCUMENTDB_TEST_MONGODB_BUNDLE,
          join(home, 'bin', `mongodb-${mongodbVersion}-${platform}`),
          'dir',
        )
      }
      assert.equal(
        (await invoke(['engines', 'download', 'mongodb', '8'])).code,
        0,
      )
      const port = await availablePort()
      await cli(
        'create',
        'source',
        '--engine',
        'documentdb',
        '--db-version',
        '1',
        '--database',
        'proof',
        '--port',
        String(port),
        '--strict-port',
        '--start',
      )
      await cli(
        'query',
        'source',
        'db.rows.insertOne({_id:"persisted",value:42})',
      )
      await assertRow('source')
      await assertPin('source')
      // The GA gateway cannot create PostgreSQL roles. The owner-authorized
      // users command must provision and update an admin through its private socket.
      const administratorArgs = [
        'users',
        'create',
        'source',
        'cloudadmin',
        '--database',
        'admin',
        '--password-stdin',
        '--no-save',
        '--json',
      ]
      for (const password of ['Disposable_admin_1', 'Disposable_admin_2']) {
        const administrator = await invoke(administratorArgs, password)
        assert.equal(
          administrator.code,
          0,
          'native administrator provisioning failed',
        )
      }
      const emptyPassword = await invoke(administratorArgs, '')
      assert.notEqual(emptyPassword.code, 0)
      const protectedRole = await invoke(
        [
          'users',
          'create',
          'source',
          'postgres',
          '--database',
          'admin',
          '--password-stdin',
          '--no-save',
          '--json',
        ],
        'Disposable_admin_3',
      )
      assert.notEqual(protectedRole.code, 0)
      await cli('stop', 'source')
      const rejectedBind = await invoke([
        'start',
        'source',
        '--bind',
        '192.0.2.1',
        '--json',
      ])
      assert.notEqual(rejectedBind.code, 0)
      assert.match(
        rejectedBind.stdout,
        /supports --bind 127\.0\.0\.1 or 0\.0\.0\.0/,
      )
      const unauthenticated = await invoke([
        'start',
        'source',
        '--no-auth',
        '--json',
      ])
      assert.notEqual(unauthenticated.code, 0)
      assert.match(unauthenticated.stdout, /requires authentication/)
      await cli('start', 'source', '--strict-port', '--bind', '0.0.0.0')
      await assertRow('source')
      const backupDirectory = join(home, 'backups')
      await mkdir(backupDirectory)
      const archive = await cli(
        'backup',
        'source',
        '--format',
        'archive',
        '--output',
        backupDirectory,
      )
      assert.equal(typeof archive.path, 'string')
      await cli(
        'branch',
        'create',
        'source',
        'branch',
        '--port',
        String(await availablePort()),
      )
      await assertRow('branch')
      await assertPin('branch')
      await cli(
        'query',
        'branch',
        'db.rows.updateOne({_id:"persisted"},{$set:{value:99}})',
      )
      await assertRow('source')
      await cli('branch', 'reset', 'branch', '--force')
      await assertRow('branch')
      await cli(
        'query',
        'branch',
        'db.rows.updateOne({_id:"persisted"},{$set:{value:77}})',
      )
      await cli(
        'restore',
        'branch',
        String(archive.path),
        '--database',
        'proof',
        '--force',
      )
      await assertRow('branch')
      await cli('stop', 'branch')
      await cli('edit', 'branch', '--name', 'renamed')
      await cli('start', 'renamed')
      await assertRow('renamed')
      await assertPin('renamed')
      await cli('stop', 'renamed')
      await cli('stop', 'source')
      const control = join(
        home,
        'containers/documentdb/source/data/global/pg_control',
      )
      const hash = async () =>
        createHash('sha256')
          .update(await readFile(control))
          .digest('hex')
      const before = await hash()
      const pinPath = join(
        home,
        'containers/documentdb/source/data/.spindb-documentdb-runtime.json',
      )
      const originalPin = await readFile(pinPath, 'utf8')
      const pinnedRuntime = new DocumentDBNativeRuntime({
        bundlePath: binaryPath,
        containerPath: join(home, 'containers/documentdb/source'),
        version: '1.0.0',
        port,
      })
      await pinnedRuntime.stop()
      await pinnedRuntime.stop()
      assert.equal(await hash(), before)
      const invalidRuntime = new DocumentDBNativeRuntime({
        bundlePath: binaryPath,
        containerPath: join(home, 'missing-container'),
        version: '1.0.0',
        port,
      })
      await assert.rejects(() => invalidRuntime.stop(), /does not exist/)
      try {
        await rm(pinPath)
        await assert.rejects(() => pinnedRuntime.start(), /ENOENT/)
        assert.equal(await hash(), before)
        await writeFile(
          pinPath,
          JSON.stringify({ ...JSON.parse(originalPin), version: '2.0.0' }),
        )
        await assert.rejects(() => pinnedRuntime.start(), /pin does not match/)
        assert.equal(await hash(), before)
      } finally {
        await writeFile(pinPath, originalPin, { mode: 0o600 })
      }
      await rename(binaryPath, binaryPath + '.held')
      held = true
      const unavailableRuntime = new DocumentDBNativeRuntime({
        bundlePath: binaryPath,
        containerPath: join(home, 'containers/documentdb/source'),
        version: '1.0.0',
        port,
      })
      await assert.rejects(() => unavailableRuntime.start())
      assert.equal(await hash(), before)
      await assertPin('source')
      // Invoke the exact-pin guard directly: a published registry would correctly
      // recover a missing cache. An unavailable local artifact must never open data.
      const guard = await invoke(['start', 'source', '--force'])
      // Before publication this must fail; after publication cache recovery may
      // succeed, in which case it must still preserve the exact version and rows.
      if (guard.code !== 0) {
        assert.equal(await hash(), before)
        await assertPin('source')
      } else {
        await assertPin('source')
        await assertRow('source')
        await cli('stop', 'source')
        await rm(binaryPath, { recursive: true })
      }
      await rename(binaryPath + '.held', binaryPath)
      held = false
      await cli('start', 'source')
      await assertRow('source')
      complete = true
    } finally {
      if (held) await rename(binaryPath + '.held', binaryPath)
      for (const name of ['renamed', 'branch', 'source']) {
        await invoke(['stop', name, '--json']).catch(() => {})
      }
      if (complete) await rm(home, { recursive: true })
    }
  },
)
