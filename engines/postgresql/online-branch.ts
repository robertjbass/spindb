import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  lstat,
  statfs,
  readFile,
  writeFile,
  realpath,
} from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { paths } from '../../config/paths'
import { defaults } from '../../config/defaults'
import { getBundledBinaryPath } from '../../core/pg-binary-resolver'
import {
  loadCredentials,
  listCredentials,
  saveCredentials,
} from '../../core/credential-manager'
import {
  registerTempDump,
  trackDumpProcess,
} from '../../core/temp-dump-cleanup'
import { Engine, type ContainerConfig } from '../../types'

const execFileAsync = promisify(execFile)

async function directoryBytes(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(
        'Online PostgreSQL branching requires a self-contained data directory. External paths are not supported; the source remains running.',
      )
    }
    try {
      if (entry.isDirectory()) total += await directoryBytes(child)
      else if (entry.isFile()) total += (await stat(child)).size
    } catch (error: unknown) {
      // PostgreSQL can remove transient files while the source is running.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return total
}

/** PostgreSQL emits regular files and directories; refuse links and paths outside the backup. */
export async function validateBranchArchive(path: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    let offset = 0
    while (offset + 512 <= size) {
      const header = Buffer.alloc(512)
      await file.read(header, 0, 512, offset)
      if (header.every((byte) => byte === 0)) return
      const field = (start: number, end: number) =>
        header.subarray(start, end).toString('utf8').split('\0')[0]
      const prefix = field(345, 500)
      const name = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`
      const type = header[156]
      if (
        !name ||
        name.startsWith('/') ||
        name.includes('\\') ||
        /^[a-z]:/i.test(name) ||
        name.split('/').includes('..') ||
        ![0, 48, 53].includes(type)
      ) {
        throw new Error(
          'Online PostgreSQL branch contains an unsupported archive entry. The source has not been stopped.',
        )
      }
      const sizeText = field(124, 136).trim()
      const entrySize = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : NaN
      if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
        throw new Error('Invalid PostgreSQL backup archive size')
      }
      offset += 512 + Math.ceil(entrySize / 512) * 512
      if (offset > size) throw new Error('Truncated PostgreSQL backup archive')
    }
    throw new Error('PostgreSQL backup archive has no end marker')
  } finally {
    await file.close()
  }
}

function configString(value: string): string {
  return `'${value.replaceAll('\\', '/').replaceAll("'", "''")}'`
}

export async function refreshOnlineBranchPaths(
  dataPath: string,
): Promise<void> {
  try {
    await readFile(join(dataPath, '.spindb-online-branch'), 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const file = join(dataPath, 'postgresql.auto.conf')
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const [key, value] of [
    ['data_directory', dataPath],
    ['hba_file', join(dataPath, 'pg_hba.conf')],
    ['ident_file', join(dataPath, 'pg_ident.conf')],
  ]) {
    content = content.replace(new RegExp(`^${key}\\s*=.*\\n?`, 'gm'), '')
    content += `\n${key} = ${configString(value)}\n`
  }
  await writeFile(file, content)
}

/** Prevent a fork from writing into its parent's paths or running inherited replication/jobs. */
export function branchConfigOverrides(dataPath: string, major: number): string {
  return (
    '\n# SpinDB online branch: independent paths and background workers\n' +
    [
      `data_directory = ${configString(dataPath)}`,
      `hba_file = ${configString(join(dataPath, 'pg_hba.conf'))}`,
      `ident_file = ${configString(join(dataPath, 'pg_ident.conf'))}`,
      "external_pid_file = ''",
      ...(process.platform === 'win32'
        ? []
        : ["unix_socket_directories = '/tmp'"]),
      'logging_collector = off',
      'archive_mode = off',
      "archive_command = ''",
      ...(major >= 15 ? ["archive_library = ''"] : []),
      "restore_command = ''",
      "archive_cleanup_command = ''",
      "recovery_end_command = ''",
      "primary_conninfo = ''",
      "primary_slot_name = ''",
      "synchronous_standby_names = ''",
      'max_logical_replication_workers = 0',
      "shared_preload_libraries = ''",
      "session_preload_libraries = ''",
      "local_preload_libraries = ''",
      "ssl_passphrase_command = ''",
    ].join('\n') +
    '\n'
  )
}

export async function retargetPostgresBranchCredentials(
  container: ContainerConfig,
): Promise<void> {
  for (const username of await listCredentials(
    container.name,
    Engine.PostgreSQL,
  )) {
    const credential = await loadCredentials(
      container.name,
      Engine.PostgreSQL,
      username,
    )
    if (!credential) continue
    let connection: URL
    try {
      connection = new URL(credential.connectionString)
    } catch {
      throw new Error('Cannot rewrite an invalid branch credential URL')
    }
    connection.hostname = '127.0.0.1'
    connection.port = String(container.port)
    await saveCredentials(container.name, Engine.PostgreSQL, {
      ...credential,
      connectionString: connection.toString(),
      container: container.name,
    })
  }
}

/** Native streamed-WAL backup: never stops the source or falls back to an offline copy. */
export async function copyOnlinePostgresContainer(
  source: ContainerConfig,
  options: { targetPath: string },
): Promise<void> {
  const major = Number(source.version.split('.')[0])
  const binary = getBundledBinaryPath('pg_basebackup', String(major))
  const psql = getBundledBinaryPath('psql', String(major))
  if (!binary || !psql) {
    throw new Error(
      `Online branching needs pg_basebackup. Run "spindb engines download postgresql ${major}" and retry. The source has not been stopped.`,
    )
  }
  const sourcePath = paths.getContainerPath(source.name, {
    engine: Engine.PostgreSQL,
  })
  const credentials = await loadCredentials(
    source.name,
    Engine.PostgreSQL,
    defaults.superuser,
  )
  const { targetPath } = options
  const connectionArgs = [
    '--host=127.0.0.1',
    `--port=${source.port}`,
    `--username=${credentials?.username || defaults.superuser}`,
    '--no-password',
  ]
  const environment = {
    ...process.env,
    PGCONNECT_TIMEOUT: '10',
    ...(credentials?.password ? { PGPASSWORD: credentials.password } : {}),
  }
  const settingsResult = await execFileAsync(
    psql,
    [
      ...connectionArgs,
      '--dbname=postgres',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `SELECT json_build_object(
      'dataDirectory', current_setting('data_directory'),
      'hba', current_setting('hba_file'),
      'ident', current_setting('ident_file'),
      'configFiles', (SELECT json_agg(DISTINCT sourcefile) FROM pg_file_settings WHERE sourcefile IS NOT NULL))`,
    ],
    { env: environment, timeout: 15_000, windowsHide: true },
  )
  const settings = JSON.parse(settingsResult.stdout) as {
    dataDirectory: string
    hba: string
    ident: string
    configFiles: string[]
  }
  const expectedData = await realpath(join(sourcePath, 'data'))
  if (
    (await realpath(settings.dataDirectory)) !== expectedData ||
    (await realpath(settings.hba)) !== join(expectedData, 'pg_hba.conf') ||
    (await realpath(settings.ident)) !== join(expectedData, 'pg_ident.conf')
  )
    throw new Error(
      'Online PostgreSQL branching requires the standard self-contained data and authentication files; the source remains running.',
    )
  for (const path of settings.configFiles) {
    const child = relative(expectedData, await realpath(path))
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
      throw new Error(
        'Online PostgreSQL branching does not support configuration includes outside its data directory; the source remains running.',
      )
    }
  }
  const sourceBytes = await directoryBytes(join(sourcePath, 'data'))
  const available = await statfs(dirname(targetPath))
  // The tar archives and extracted cluster coexist until verification finishes.
  // Leave another copy's worth of headroom for concurrent WAL/data growth.
  if (
    available.bavail * available.bsize <
    sourceBytes * 3 + 256 * 1024 * 1024
  ) {
    throw new Error(
      'Insufficient disk space for a safe online PostgreSQL branch. Free space for three copies of the source plus 256 MiB and retry; the source remains running.',
    )
  }
  const releaseTarget = registerTempDump(targetPath)
  let backupPath: string | undefined
  try {
    backupPath = await mkdtemp(join(targetPath, '.online-backup-'))
    // Tar format confines even external tablespaces to this scratch directory.
    // Plain format can write tablespaces back to their original absolute paths.
    const backup = execFileAsync(
      binary,
      [
        ...connectionArgs,
        `--pgdata=${backupPath}`,
        '--format=tar',
        '--wal-method=stream',
        '--checkpoint=fast',
      ],
      {
        timeout: 30 * 60 * 1000,
        env: environment,
        windowsHide: true,
      },
    )
    const releaseProcess = trackDumpProcess(backup.child)
    try {
      await backup
    } finally {
      releaseProcess()
    }

    const archives = await readdir(backupPath)
    if (
      archives.some(
        (name) => !['base.tar', 'pg_wal.tar', 'backup_manifest'].includes(name),
      )
    ) {
      throw new Error(
        'Online PostgreSQL branching does not yet support external tablespaces. The source has not been stopped or changed.',
      )
    }
    // Validate both before extracting either. Never follow an inherited symlink.
    for (const name of ['base.tar', 'pg_wal.tar']) {
      await validateBranchArchive(join(backupPath, name))
    }
    const dataPath = join(targetPath, 'data')
    await mkdir(dataPath, { mode: 0o700 })
    for (const [name, destination] of [
      ['base.tar', dataPath],
      ['pg_wal.tar', join(dataPath, 'pg_wal')],
    ]) {
      await mkdir(destination, { recursive: true, mode: 0o700 })
      const extraction = execFileAsync(
        'tar',
        ['-xf', join(backupPath, name), '-C', destination],
        { windowsHide: true },
      )
      const releaseExtraction = trackDumpProcess(extraction.child)
      try {
        await extraction
      } finally {
        releaseExtraction()
      }
    }
    await writeFile(join(dataPath, '.spindb-online-branch'), '1\n', {
      mode: 0o600,
    })
    await appendFile(
      join(dataPath, 'postgresql.auto.conf'),
      branchConfigOverrides(dataPath, major),
    )
    for (const file of [
      'standby.signal',
      'recovery.signal',
      'postmaster.pid',
      'postmaster.opts',
    ]) {
      await rm(join(dataPath, file), { force: true })
    }
    const credentialSource = join(sourcePath, 'credentials')
    let credentialFiles: string[] = []
    try {
      credentialFiles = await readdir(credentialSource)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (credentialFiles.length) {
      await mkdir(join(targetPath, 'credentials'), { mode: 0o700 })
      for (const name of credentialFiles) {
        if (!/^\.env\.[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) continue
        const credential = join(credentialSource, name)
        const info = await lstat(credential)
        if (!info.isFile()) throw new Error('Unsupported credential file type')
        await copyFile(credential, join(targetPath, 'credentials', name))
      }
    }
    // Copy only metadata and credentials, never process state or auxiliary services.
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        (entry.name === 'container.json' ||
          entry.name === '.env.spindb' ||
          entry.name.startsWith('.env.spindb.'))
      ) {
        await copyFile(
          join(sourcePath, entry.name),
          join(targetPath, entry.name),
        )
      }
    }
  } catch (error: unknown) {
    await rm(targetPath, { recursive: true, force: true })
    throw error
  } finally {
    try {
      if (backupPath) await rm(backupPath, { recursive: true, force: true })
    } finally {
      releaseTarget()
    }
  }
}
