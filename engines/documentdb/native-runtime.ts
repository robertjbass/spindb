import { spawn, execFile } from 'child_process'
import { existsSync } from 'fs'
import {
  mkdir,
  writeFile,
  readFile,
  open,
  unlink,
  chmod,
  readdir,
} from 'fs/promises'
import { join, resolve } from 'path'
import { userInfo } from 'os'
import { setTimeout as delay } from 'timers/promises'
import { spawnAsync } from '../../core/spawn-utils'
import {
  buildGatewayConfig,
  buildPeerAuthentication,
  buildPostgresConfig,
  DOCUMENTDB_GATEWAY_ROLE,
} from './runtime-config'

type RuntimeOptions = {
  bundlePath: string
  containerPath: string
  version: string
  port: number
  bindAddress?: string
}

type BundleMetadata = {
  name: string
  version: string
  components: { postgresql: string; documentdb: string; gateway: string }
}

// Kept in the data directory so branch/clone carries the exact runtime pin.
const PIN_FILE = '.spindb-documentdb-runtime.json'

export async function verifyDocumentDBBundle(
  bundlePath: string,
  version: string,
): Promise<BundleMetadata> {
  const metadata = JSON.parse(
    await readFile(join(bundlePath, '.hostdb-metadata.json'), 'utf8'),
  ) as BundleMetadata
  if (
    metadata.name !== 'documentdb' ||
    metadata.version !== version ||
    metadata.components?.documentdb !== version ||
    metadata.components?.gateway !== version ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(metadata.components?.postgresql ?? '')
  ) {
    throw new Error(
      `DocumentDB ${version} bundle metadata does not match the exact requested runtime`,
    )
  }
  for (const tool of [
    'postgres',
    'pg_ctl',
    'initdb',
    'psql',
    'pg_dump',
    'pg_restore',
    'documentdb_gateway',
  ]) {
    if (!existsSync(join(bundlePath, 'bin', tool))) {
      throw new Error(`DocumentDB ${version} bundle is missing ${tool}`)
    }
  }
  const gateway = await spawnAsync(
    join(bundlePath, 'bin/documentdb_gateway'),
    ['--version'],
    { timeout: 10000 },
  )
  const actualGateway = gateway.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
  const postgres = await spawnAsync(
    join(bundlePath, 'bin/postgres'),
    ['--version'],
    { timeout: 10000 },
  )
  const actualPostgres = postgres.stdout.match(/\b(\d+\.\d+(?:\.\d+)?)\b/)?.[1]
  if (
    actualGateway !== version ||
    actualPostgres !== metadata.components.postgresql
  ) {
    throw new Error(
      `DocumentDB ${version} binary versions disagree with the bundle metadata`,
    )
  }
  return metadata
}

export class DocumentDBNativeRuntime {
  private readonly options: RuntimeOptions
  readonly dataPath: string
  readonly socketPath: string
  readonly configPath: string

  constructor(options: RuntimeOptions) {
    this.options = {
      ...options,
      bundlePath: resolve(options.bundlePath),
      containerPath: resolve(options.containerPath),
    }
    this.dataPath = join(this.options.containerPath, 'data')
    // Keep Cloud's UUID container paths below sockaddr_un's length limit.
    this.socketPath = join(this.options.containerPath, 's')
    this.configPath = join(
      this.options.containerPath,
      'documentdb-gateway.json',
    )
    // Validate before touching data, including unsupported network binds.
    buildPostgresConfig({ socketDirectory: this.socketPath, port: 5432 })
    buildGatewayConfig({
      socketDirectory: this.socketPath,
      backendPort: 5432,
      port: options.port,
      bindAddress: options.bindAddress,
    })
  }

  private tool(name: string): string {
    return join(this.options.bundlePath, 'bin', name)
  }

  private environment(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^(PG|DOCUMENTDB_|OTEL_)/.test(key)) delete env[key]
    }
    return {
      ...env,
      PGHOST: this.socketPath,
      PGPORT: '5432',
      PGUSER: 'postgres',
      DOCUMENTDB_TLS_STATE_DIR: join(this.options.containerPath, 'tls'),
    }
  }

  private async pgControl(action: 'start' | 'stop'): Promise<void> {
    const args =
      action === 'start'
        ? [
            'start',
            '-D',
            this.dataPath,
            '-l',
            join(this.options.containerPath, 'postgres.log'),
            '-w',
            '-t',
            '30',
          ]
        : ['stop', '-D', this.dataPath, '-m', 'fast', '-w', '-t', '30']
    try {
      await spawnAsync(this.tool('pg_ctl'), args, { timeout: 45000 })
    } catch (error) {
      if (action !== 'stop') throw error
      // Only pg_ctl status 3 with its exact no-server result is idempotent.
      // Missing/invalid data directories, timeouts and permission failures
      // must still surface the original shutdown error.
      const stopped = await new Promise<boolean>((resolveStatus) => {
        execFile(
          this.tool('pg_ctl'),
          ['status', '-D', this.dataPath],
          { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } },
          (statusError, stdout) => {
            resolveStatus(
              statusError?.code === 3 &&
                stdout.trim() === 'pg_ctl: no server running',
            )
          },
        )
      })
      if (!stopped) throw error
    }
  }

  // Credential-bearing SQL goes through stdin; errors never echo its input.
  private async sql(input: string): Promise<string> {
    return new Promise((resolveResult, reject) => {
      const proc = spawn(
        this.tool('psql'),
        ['-X', '-tA', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
        { env: this.environment(), stdio: ['pipe', 'pipe', 'pipe'] },
      )
      let output = ''
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new Error('DocumentDB initialization SQL timed out'))
      }, 30000)
      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString()
      })
      proc.stderr.resume()
      proc.on('error', () => {
        clearTimeout(timer)
        reject(new Error('Cannot launch the bundled DocumentDB psql'))
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolveResult(output.trim())
        else
          reject(
            new Error(
              `DocumentDB initialization SQL failed (exit ${code}); initialization remains incomplete`,
            ),
          )
      })
      proc.stdin.on('error', () => {})
      proc.stdin.end(input)
    })
  }

  async provisionAdministrator(
    username: string,
    password: string,
  ): Promise<void> {
    await this.verifyRuntimePin()
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(username) ||
      /^(pg_|documentdb|spindb_)/.test(username) ||
      username === 'postgres' ||
      !password ||
      /[\r\n\0]/.test(password)
    ) {
      throw new Error('Invalid DocumentDB administrator credentials')
    }
    const command = JSON.stringify({
      createUser: username,
      pwd: password,
      roles: [
        { role: 'readWriteAnyDatabase', db: 'admin' },
        { role: 'clusterAdmin', db: 'admin' },
      ],
      $db: 'admin',
    })
    const update = JSON.stringify({
      updateUser: username,
      pwd: password,
      $db: 'admin',
    })
    const literal = (value: string) => `'${value.replace(/'/g, "''")}'`
    // Owner-only local operation, matching upstream's gateway-admin tooling.
    // Refuse collisions with an unrelated PostgreSQL role rather than adopting it.
    const exists = await this.sql(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(username)});`,
    )
    if (exists === 't') {
      if (
        (await this.sql(
          `SELECT NOT rolsuper AND pg_has_role(rolname, 'documentdb_admin_role', 'MEMBER') FROM pg_roles WHERE rolname = ${literal(username)};`,
        )) !== 't'
      ) {
        throw new Error('Existing role is not a DocumentDB administrator')
      }
      await this.sql(
        `SELECT documentdb_api.update_user(${literal(update)}::documentdb_core.bson);`,
      )
    } else {
      await this.sql(
        `SELECT documentdb_api.create_user(${literal(command)}::documentdb_core.bson);`,
      )
    }
  }

  async initialize(credentials: {
    username: string
    password: string
  }): Promise<void> {
    const metadata = await verifyDocumentDBBundle(
      this.options.bundlePath,
      this.options.version,
    )
    if (
      existsSync(this.dataPath) &&
      (await readdir(this.dataPath)).length > 0
    ) {
      throw new Error(
        'DocumentDB data directory already exists; refusing to initialize or assign a guessed runtime pin',
      )
    }
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(credentials.username) ||
      !credentials.password ||
      /[\r\n\0]/.test(credentials.password)
    ) {
      throw new Error('Invalid DocumentDB bootstrap credentials')
    }
    await mkdir(this.options.containerPath, { recursive: true, mode: 0o700 })
    await mkdir(this.socketPath, { mode: 0o700, recursive: true })
    await chmod(this.socketPath, 0o700)
    await spawnAsync(
      this.tool('initdb'),
      [
        '-D',
        this.dataPath,
        '-U',
        'postgres',
        '--encoding=UTF8',
        '--no-locale',
        '--auth=peer',
      ],
      { timeout: 120000 },
    )
    const { hba, ident } = buildPeerAuthentication(userInfo().username)
    await writeFile(join(this.dataPath, 'pg_hba.conf'), hba, { mode: 0o600 })
    await writeFile(join(this.dataPath, 'pg_ident.conf'), ident, {
      mode: 0o600,
    })
    await this.writeConfiguration()
    await this.pgControl('start')
    try {
      await this.sql(
        'CREATE EXTENSION documentdb CASCADE; CREATE EXTENSION documentdb_extended_rum;',
      )
      const expectedExtension = this.options.version.replace(/\.(\d+)$/, '-$1')
      if (
        (await this.sql(
          "SELECT extversion FROM pg_extension WHERE extname = 'documentdb';",
        )) !== expectedExtension
      ) {
        throw new Error(
          'DocumentDB extension version does not match its exact pin',
        )
      }
      await this.sql(
        `CREATE ROLE ${DOCUMENTDB_GATEWAY_ROLE} LOGIN; GRANT documentdb_admin_role, documentdb_readwrite_role, documentdb_readonly_role TO ${DOCUMENTDB_GATEWAY_ROLE};`,
      )
      const command = JSON.stringify({
        createUser: credentials.username,
        pwd: credentials.password,
        roles: [
          { role: 'readWriteAnyDatabase', db: 'admin' },
          { role: 'clusterAdmin', db: 'admin' },
        ],
        $db: 'admin',
      })
      await this.sql(
        `SELECT documentdb_api.create_user('${command.replace(/'/g, "''")}'::documentdb_core.bson);`,
      )
      // Upstream's temporary unsupported-command bridge preserves a real function.
      const stub = await readFile(
        join(
          this.options.bundlePath,
          'share/documentdb/documentdb_install_getparameter_stub.sh',
        ),
        'utf8',
      )
      const stubSql = stub
        .split("<<'GET_PARAMETER_SQL'\n")[1]
        ?.split('\nGET_PARAMETER_SQL')[0]
      if (!stubSql)
        throw new Error(
          'DocumentDB bundle is missing the expected getParameter bridge',
        )
      await this.sql(stubSql)
      await writeFile(join(this.dataPath, PIN_FILE), JSON.stringify(metadata), {
        mode: 0o600,
        flag: 'wx',
      })
    } finally {
      await this.pgControl('stop')
    }
  }

  private async writeConfiguration(): Promise<void> {
    await writeFile(
      join(this.dataPath, 'postgresql.conf'),
      buildPostgresConfig({ socketDirectory: this.socketPath, port: 5432 }),
      { mode: 0o600 },
    )
    await writeFile(
      this.configPath,
      JSON.stringify(
        buildGatewayConfig({
          socketDirectory: this.socketPath,
          backendPort: 5432,
          port: this.options.port,
          bindAddress: this.options.bindAddress,
        }),
      ),
      { mode: 0o600 },
    )
  }

  private async verifyRuntimePin(): Promise<void> {
    const metadata = await verifyDocumentDBBundle(
      this.options.bundlePath,
      this.options.version,
    )
    const pin = JSON.parse(
      await readFile(join(this.dataPath, PIN_FILE), 'utf8'),
    ) as BundleMetadata
    if (
      pin.version !== metadata.version ||
      JSON.stringify(pin.components) !== JSON.stringify(metadata.components)
    ) {
      throw new Error(
        'DocumentDB data pin does not match the requested runtime; refusing to start',
      )
    }
    // Socket paths and listener ports change after a branch or rename.
    await mkdir(this.socketPath, { recursive: true, mode: 0o700 })
    await chmod(this.socketPath, 0o700)
  }

  async start(): Promise<void> {
    await this.verifyRuntimePin()
    await this.writeConfiguration()
    await this.pgControl('start')
    try {
      const log = await open(
        join(this.options.containerPath, 'documentdb.log'),
        'a',
        0o600,
      )
      try {
        const proc = spawn(
          this.tool('documentdb_gateway'),
          ['run', '--config', this.configPath],
          {
            detached: true,
            env: this.environment(),
            stdio: ['ignore', log.fd, log.fd],
          },
        )
        await new Promise<void>((resolveSpawn, reject) => {
          proc.once('spawn', resolveSpawn)
          proc.once('error', reject)
        })
        await writeFile(
          join(this.options.containerPath, 'documentdb.pid'),
          String(proc.pid),
          { mode: 0o600 },
        )
        proc.unref()
      } finally {
        await log.close()
      }
    } catch (error) {
      await this.pgControl('stop')
      throw error
    }
  }

  async stop(): Promise<void> {
    const pidFile = join(this.options.containerPath, 'documentdb.pid')
    if (existsSync(pidFile)) {
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      if (!Number.isInteger(pid) || pid <= 1)
        throw new Error('Invalid DocumentDB gateway PID file')
      const alive = (): boolean => {
        try {
          process.kill(pid, 0)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
          throw error
        }
      }
      const procPath = `/proc/${pid}/cmdline`
      const present = () =>
        process.platform === 'darwin' ? alive() : existsSync(procPath)
      if (present()) {
        const expected = [
          this.tool('documentdb_gateway'),
          'run',
          '--config',
          this.configPath,
        ]
        let matches: boolean
        if (process.platform === 'darwin') {
          const command = await spawnAsync('/bin/ps', [
            '-p',
            String(pid),
            '-o',
            'command=',
          ])
          matches = command.stdout.trim() === expected.join(' ')
        } else {
          const args = (await readFile(procPath, 'utf8'))
            .split('\0')
            .filter(Boolean)
          matches =
            args.length === expected.length &&
            args.every((arg, i) => arg === expected[i])
        }
        if (!matches) {
          throw new Error(
            'DocumentDB gateway PID belongs to another process; refusing to stop it',
          )
        }
        process.kill(pid, 'SIGTERM')
        for (let attempt = 0; attempt < 100 && present(); attempt++)
          await delay(100)
        if (present())
          throw new Error(
            'DocumentDB gateway did not exit; backend kept running',
          )
      }
      await unlink(pidFile)
    }
    await this.pgControl('stop')
  }
}
