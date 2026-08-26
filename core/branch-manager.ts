/**
 * Branch Manager
 *
 * Database branching, Neon/Vercel-style but local and engine-agnostic. A
 * "branch" is a copy-on-write fork of a container's data directory (instant and
 * near-zero-space on filesystems that support reflinks — APFS, Btrfs, XFS with
 * reflink, ZFS — and a full copy elsewhere) that records its parent so branches
 * form a lineage tree.
 *
 * Live sources are handled with an auto stop -> snapshot -> restart cycle: a
 * running source is briefly stopped so its on-disk state is consistent, the
 * data dir is duplicated, and the source is restarted immediately to minimize
 * downtime. This works uniformly across all engines and all platforms.
 *
 * The mechanical copy + config rewrite lives in
 * `containerManager.copyContainerData()` (shared with `clone()`); this module
 * owns the orchestration (stop/restart, lineage tree, reset, cascade delete)
 * and the file-based engine path (SQLite/DuckDB copy the backing file and
 * register a new entry rather than copying a server data dir).
 */

import { existsSync, statSync } from 'fs'
import { copyFile, mkdir, rename, rm } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomBytes } from 'crypto'
import { basename, join, extname, dirname } from 'path'
import { paths } from '../config/paths'
import { containerManager, assertDataDirCopyable } from './container-manager'
import { processManager } from './process-manager'
import { startContainerWithRetry } from './start-with-retry'
import { cloneDirectory, type CopyMethod } from './cow-copy'
import { logDebug } from './error-handler'
import { getEngine } from '../engines'
import { sqliteRegistry } from '../engines/sqlite/registry'
import { duckdbRegistry } from '../engines/duckdb/registry'
import type { ContainerConfig } from '../types'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../types'

const execFileAsync = promisify(execFile)

/**
 * Write-ahead-log siblings of a file-based database's backing file. SQLite in
 * WAL mode keeps un-checkpointed writes in `<file>-wal` (with `<file>-shm` as
 * the shared-memory index); DuckDB keeps them in `<file>.wal`.
 */
function walSiblings(engine: FileBasedEngine, filePath: string): string[] {
  return engine === Engine.SQLite
    ? [`${filePath}-wal`, `${filePath}-shm`]
    : [`${filePath}.wal`]
}

/** Does this database have un-checkpointed writes sitting outside its main file? */
function hasPendingWal(engine: FileBasedEngine, filePath: string): boolean {
  const wal = engine === Engine.SQLite ? `${filePath}-wal` : `${filePath}.wal`
  try {
    return statSync(wal).size > 0
  } catch {
    return false
  }
}

export type CreateBranchResult = {
  config: ContainerConfig
  /** 'reflink' when the branch was an instant copy-on-write clone, 'copy' for a full byte copy. */
  method: CopyMethod
  /** Whether the branch's server was started (always true for file-based engines). */
  started: boolean
  connectionString: string
  /** Non-fatal warning, e.g. the source failed to restart, or the branch failed to start. */
  warning?: string
}

/** A node in the branch lineage tree. */
export type BranchNode = {
  name: string
  engine: Engine
  status: ContainerConfig['status']
  port: number
  branchParent?: string
  branchedAt?: string
  gitBranch?: string
  children: BranchNode[]
}

type FileBasedEngine = Engine.SQLite | Engine.DuckDB

type FileEntryUpdate = Partial<{
  filePath: string
  created: string
  lastVerified: string
  branchParent: string
  branchedAt: string
  gitBranch: string
}>

class BranchManager {
  /**
   * Create a branch of `source` named `name`.
   *
   * For server engines: if the source is running it is briefly stopped, its
   * data directory is copy-on-write cloned, and the source is restarted. The
   * branch is then started (unless `start: false`).
   *
   * For file-based engines (SQLite/DuckDB): the backing file is cloned and a
   * new registry entry is added.
   */
  async createBranch(options: {
    source: string
    name: string
    /** Start the branch after creating it. Default true. */
    start?: boolean
    /** Explicit port (stable-port git branches); otherwise the next free port is assigned. */
    port?: number
    /** Git branch this DB branch is bound to (git-hook framework). */
    gitBranch?: string
    /**
     * File-based engines only (SQLite/DuckDB): write the branch's backing file
     * to this exact path instead of the default container dir. Lets a caller
     * (e.g. layerbase-cloud) place the file where its server shim expects it.
     */
    path?: string
  }): Promise<CreateBranchResult> {
    const { source, name, start = true, port, gitBranch, path } = options

    if (!containerManager.isValidName(name)) {
      throw new Error(
        'Branch name must be alphanumeric with hyphens/underscores only',
      )
    }

    const sourceConfig = await containerManager.getConfig(source)
    if (!sourceConfig) {
      throw new Error(`Source container "${source}" not found`)
    }
    if (isRemoteContainer(sourceConfig)) {
      throw new Error(
        'Cannot branch a linked remote container. Use "spindb backup" to export data, then "spindb restore" to import it locally.',
      )
    }

    const { engine } = sourceConfig
    // Refuse here, not deeper in the copy: a live source is STOPPED before the
    // data directory is duplicated, so a late failure would take the user's
    // database down for nothing.
    assertDataDirCopyable(engine, 'Branching')

    if (await containerManager.exists(name, { engine })) {
      throw new Error(`Container "${name}" already exists`)
    }

    if (path && !isFileBasedEngine(engine)) {
      throw new Error(
        'The --path option is only supported for file-based engines (SQLite, DuckDB).',
      )
    }

    if (isFileBasedEngine(engine)) {
      return this.createFileBasedBranch({
        source,
        name,
        engine: engine as FileBasedEngine,
        gitBranch,
        path,
      })
    }

    return this.createServerBranch({
      source,
      sourceConfig,
      name,
      start,
      port,
      gitBranch,
    })
  }

  private async createServerBranch(opts: {
    source: string
    sourceConfig: ContainerConfig
    name: string
    start: boolean
    port?: number
    gitBranch?: string
  }): Promise<CreateBranchResult> {
    const { source, sourceConfig, name, start, port, gitBranch } = opts
    const { engine } = sourceConfig

    // Auto stop -> snapshot -> restart: stop a running source so its on-disk
    // state is consistent before we clone it.
    const sourceWasRunning = await processManager.isRunning(source, { engine })
    if (sourceWasRunning) {
      await this.stopServer(sourceConfig)
    }

    let result: { config: ContainerConfig; method: CopyMethod }
    try {
      result = await containerManager.copyContainerData({
        sourceName: source,
        targetName: name,
        strategy: 'cow',
        lineage: { branchParent: source },
        port,
      })
    } catch (error) {
      // Bring the source back up before surfacing the failure.
      if (sourceWasRunning) {
        await this.startServer(sourceConfig).catch((restartError) => {
          logDebug(
            `Failed to restart source "${source}" after failed branch: ${restartError}`,
          )
        })
      }
      throw error
    }

    // Data is cloned — restart the source immediately to minimize its downtime.
    let warning: string | undefined
    if (sourceWasRunning) {
      try {
        await this.startServer(sourceConfig)
      } catch (error) {
        warning = `Source "${source}" failed to restart after branching: ${
          (error as Error).message
        }`
        logDebug(warning)
      }
    }

    if (gitBranch) {
      await containerManager.updateConfig(name, { gitBranch })
      result.config.gitBranch = gitBranch
    }

    let started = false
    if (start) {
      try {
        await this.startServer(result.config)
        result.config.status = 'running'
        started = true
      } catch (error) {
        const branchWarning = `Branch "${name}" was created but failed to start: ${
          (error as Error).message
        }`
        warning = warning ? `${warning}; ${branchWarning}` : branchWarning
        logDebug(branchWarning)
      }
    }

    const connectionString = getEngine(engine).getConnectionString(
      result.config,
    )
    return {
      config: result.config,
      method: result.method,
      started,
      connectionString,
      warning,
    }
  }

  /**
   * Copy a file-based database's backing file, WRITE-AHEAD LOG INCLUDED.
   *
   * A bare file clone is not a copy of the DATABASE whenever a writer has the
   * file open. SQLite in WAL mode parks every un-checkpointed write in a `-wal`
   * sibling and DuckDB parks them in a `.wal` sibling, so cloning the main file
   * alone produces a database that is valid, opens cleanly, answers queries -
   * and is missing everything written since the last checkpoint. For a table
   * created moments ago that is the whole table: a two-row SQLite table lived
   * entirely in the WAL, the clone's main file was a bare 4KB header, and the
   * branch answered "no such table". That is C-142, and it is silent: nothing
   * fails, the branch just has none of the parent's data.
   *
   * So the clone is only used when there is nothing outstanding. With a
   * non-empty WAL:
   *
   *   SQLite - `.backup`, the online backup API. It reads through the WAL and
   *     produces a consistent snapshot while the writer keeps serving, so it is
   *     correct even against a live database (the same reason the cloud's SQLite
   *     backup uses it instead of `cp`).
   *
   *   DuckDB - CHECKPOINT the source to fold its WAL into the file, then clone.
   *     DuckDB takes an exclusive lock on an open database, so this fails when
   *     another process holds it (a proxy serving the file). It is not fatal:
   *     the `.wal` sibling is copied alongside the main file so the data still
   *     travels, and the caller gets a warning saying the copy was taken from a
   *     database it could not quiesce.
   */
  private async copyDatabaseFile(opts: {
    engine: FileBasedEngine
    sourceFile: string
    targetFile: string
  }): Promise<{ method: CopyMethod; warning?: string }> {
    const { engine, sourceFile, targetFile } = opts

    if (!hasPendingWal(engine, sourceFile)) {
      return { method: (await cloneDirectory(sourceFile, targetFile)).method }
    }

    if (engine === Engine.SQLite) {
      const sqlite3 = await getEngine(Engine.SQLite).getSqlite3Path()
      if (!sqlite3) {
        throw new Error(
          'Cannot branch this SQLite database: it has un-checkpointed WAL data and no sqlite3 binary is available to copy it safely. Run "spindb engines download sqlite" and try again.',
        )
      }
      // `.backup` is a dot-command, so its argument is parsed by the sqlite3
      // shell, not by us: a path containing a quote cannot be expressed. Write
      // to a generated, quote-free name relative to the target directory (passed
      // as cwd) and rename into place - which also means a failed backup never
      // leaves a half-written file at the target path.
      const targetDir = dirname(targetFile)
      const scratch = `.spindb-branch-${randomBytes(6).toString('hex')}.tmp`
      try {
        await execFileAsync(sqlite3, [sourceFile, `.backup '${scratch}'`], {
          cwd: targetDir,
        })
        await rename(join(targetDir, scratch), targetFile)
      } catch (error) {
        await rm(join(targetDir, scratch), { force: true }).catch(() => {})
        throw error
      }
      return { method: 'copy' }
    }

    const duckdb = await getEngine(Engine.DuckDB).getDuckDBPath()
    let checkpointed = false
    if (duckdb) {
      try {
        await execFileAsync(duckdb, [sourceFile, '-c', 'CHECKPOINT;'])
        checkpointed = true
      } catch (error) {
        logDebug(`CHECKPOINT before branching ${sourceFile} failed: ${error}`)
      }
    }

    const { method } = await cloneDirectory(sourceFile, targetFile)
    if (checkpointed && !hasPendingWal(engine, sourceFile)) {
      return { method }
    }

    // Could not quiesce the source (another process holds it, or no duckdb
    // binary): carry the WAL across so the recent writes are not dropped.
    await copyFile(`${sourceFile}.wal`, `${targetFile}.wal`)
    return {
      method,
      warning: `Source "${basename(sourceFile)}" could not be checkpointed before branching (it is open elsewhere); its write-ahead log was copied alongside the database.`,
    }
  }

  private async createFileBasedBranch(opts: {
    source: string
    name: string
    engine: FileBasedEngine
    gitBranch?: string
    path?: string
  }): Promise<CreateBranchResult> {
    const { source, name, engine, gitBranch, path } = opts

    const sourceEntry = await this.fileRegistryGet(engine, source)
    if (!sourceEntry) {
      throw new Error(`Source container "${source}" not found in registry`)
    }
    if (!existsSync(sourceEntry.filePath)) {
      throw new Error(`Source database file not found: ${sourceEntry.filePath}`)
    }

    const ext =
      extname(sourceEntry.filePath) ||
      (engine === Engine.SQLite ? '.sqlite' : '.duckdb')
    // With an explicit path, write the branch file exactly there (the caller
    // owns the location — e.g. layerbase-cloud points pgsqlite/duckgres at it).
    // Otherwise fall back to the per-branch container dir.
    const targetFile =
      path ?? join(paths.getContainerPath(name, { engine }), `${name}${ext}`)
    const targetDir = dirname(targetFile)

    // With an explicit path the target dir may be shared and the file may
    // already exist (or even BE the source's file). Refuse up front rather than
    // clobber it — this also guarantees the failure-cleanup below only ever
    // removes a file this call created.
    if (path && existsSync(targetFile)) {
      throw new Error(
        `Cannot branch to "${targetFile}": a file already exists there. Choose a different --path or remove it first.`,
      )
    }

    await mkdir(targetDir, { recursive: true })

    let method: CopyMethod
    let warning: string | undefined
    try {
      ;({ method, warning } = await this.copyDatabaseFile({
        engine,
        sourceFile: sourceEntry.filePath,
        targetFile,
      }))
      const now = new Date().toISOString()
      await this.addFileEntry(engine, {
        name,
        filePath: targetFile,
        created: now,
        lastVerified: now,
        branchParent: source,
        branchedAt: now,
        ...(gitBranch ? { gitBranch } : {}),
      })
    } catch (error) {
      // Clean up the partial branch on failure. With an explicit path the
      // target dir may be shared (e.g. the home dir), so remove only the file
      // we wrote — never the directory. The default container dir is dedicated
      // to this branch, so it's safe to remove whole.
      if (path) {
        for (const stale of [targetFile, ...walSiblings(engine, targetFile)]) {
          await rm(stale, { force: true }).catch(() => {})
        }
      } else {
        await rm(targetDir, { recursive: true, force: true }).catch(() => {})
      }
      throw error
    }

    const config = await containerManager.getConfig(name, { engine })
    if (!config) {
      throw new Error('Failed to read branched container config')
    }
    const connectionString = getEngine(engine).getConnectionString(config)
    return { config, method, started: true, connectionString, warning }
  }

  /**
   * Build the branch lineage forest. Every container is a node; branches nest
   * under their parent. Containers with no parent (or whose parent has been
   * deleted) are roots.
   */
  async getBranchTree(): Promise<BranchNode[]> {
    const all = await containerManager.list()
    const byName = new Map<string, BranchNode>()
    for (const c of all) {
      byName.set(c.name, {
        name: c.name,
        engine: c.engine,
        status: c.status,
        port: c.port,
        branchParent: c.branchParent,
        branchedAt: c.branchedAt,
        gitBranch: c.gitBranch,
        children: [],
      })
    }

    const roots: BranchNode[] = []
    for (const node of byName.values()) {
      const parent = node.branchParent
        ? byName.get(node.branchParent)
        : undefined
      if (parent) {
        parent.children.push(node)
      } else {
        roots.push(node)
      }
    }

    const sortRecursive = (nodes: BranchNode[]): void => {
      nodes.sort((a, b) => a.name.localeCompare(b.name))
      for (const node of nodes) sortRecursive(node.children)
    }
    sortRecursive(roots)
    return roots
  }

  /** Names of branches whose immediate parent is `name`. */
  async childrenOf(name: string): Promise<string[]> {
    const all = await containerManager.list()
    return all.filter((c) => c.branchParent === name).map((c) => c.name)
  }

  /**
   * Delete a branch. Refuses if the branch has children unless `cascade` is set,
   * in which case the whole subtree is deleted (deepest first).
   */
  async deleteBranch(
    name: string,
    options: { cascade?: boolean } = {},
  ): Promise<{ deleted: string[] }> {
    const config = await containerManager.getConfig(name)
    if (!config) {
      throw new Error(`Container "${name}" not found`)
    }

    const all = await containerManager.list()
    const children = all.filter((c) => c.branchParent === name)
    if (children.length > 0 && !options.cascade) {
      const childList = children.map((c) => `"${c.name}"`).join(', ')
      throw new Error(
        `Branch "${name}" has ${children.length} child branch(es): ${childList}. ` +
          `Use --cascade to delete them too, or delete/reset the children first.`,
      )
    }

    const deleted: string[] = []
    if (options.cascade) {
      for (const child of children) {
        const childResult = await this.deleteBranch(child.name, {
          cascade: true,
        })
        deleted.push(...childResult.deleted)
      }
    }

    // Stop a running server branch before removing it. NOTE: no copy guard here
    // on purpose - deletion copies nothing, and a user who branched CouchDB
    // before the refusal existed must still be able to clean that branch up.
    if (!isFileBasedEngine(config.engine) && !isRemoteContainer(config)) {
      const running = await processManager.isRunning(name, {
        engine: config.engine,
      })
      if (running) {
        await this.stopServer(config)
      }
    }

    await containerManager.delete(name, { force: true })
    deleted.push(name)
    return { deleted }
  }

  /**
   * Reset a branch: discard its divergence and re-fork from the parent's
   * current state. Destructive — the branch's data is replaced by a fresh copy
   * of the parent's data. The branch keeps its name, port, and git binding.
   */
  async resetBranch(name: string): Promise<CreateBranchResult> {
    const branchConfig = await containerManager.getConfig(name)
    if (!branchConfig) {
      throw new Error(`Container "${name}" not found`)
    }
    // A reset re-copies the parent's data directory, so it carries the same
    // hazard as creating the branch did. Refuse BEFORE anything is touched: the
    // reset path stops BOTH the branch and the parent, and removes the branch's
    // data dir, so a late failure would take the user's database down and delete
    // data on its way to erroring.
    assertDataDirCopyable(branchConfig.engine, 'Resetting a branch')
    if (!branchConfig.branchParent) {
      throw new Error(`"${name}" is not a branch (no parent to reset from).`)
    }
    const parentName = branchConfig.branchParent
    const parentConfig = await containerManager.getConfig(parentName)
    if (!parentConfig) {
      throw new Error(
        `Parent container "${parentName}" of branch "${name}" no longer exists; cannot reset.`,
      )
    }

    const { engine } = branchConfig
    if (isFileBasedEngine(engine)) {
      return this.resetFileBasedBranch(branchConfig, parentConfig)
    }

    const branchWasRunning = await processManager.isRunning(name, { engine })
    if (branchWasRunning) {
      await this.stopServer(branchConfig)
    }
    const parentWasRunning = await processManager.isRunning(parentName, {
      engine,
    })
    if (parentWasRunning) {
      await this.stopServer(parentConfig)
    }

    const preservedPort = branchConfig.port
    const preservedGitBranch = branchConfig.gitBranch

    let result: { config: ContainerConfig; method: CopyMethod }
    try {
      // Drop the diverged data dir, then re-copy the parent's current data
      // into a fresh container that keeps the branch's port.
      await rm(paths.getContainerPath(name, { engine }), {
        recursive: true,
        force: true,
      })
      result = await containerManager.copyContainerData({
        sourceName: parentName,
        targetName: name,
        strategy: 'cow',
        lineage: { branchParent: parentName },
        port: preservedPort,
      })
    } finally {
      if (parentWasRunning) {
        await this.startServer(parentConfig).catch((error) => {
          logDebug(
            `Failed to restart parent "${parentName}" after reset: ${error}`,
          )
        })
      }
    }

    // copyContainerData clears git binding — re-apply it.
    if (preservedGitBranch) {
      await containerManager.updateConfig(name, {
        gitBranch: preservedGitBranch,
      })
      result.config.gitBranch = preservedGitBranch
    }

    let started = false
    let warning: string | undefined
    if (branchWasRunning) {
      try {
        await this.startServer(result.config)
        result.config.status = 'running'
        started = true
      } catch (error) {
        warning = `Branch "${name}" was reset but failed to restart: ${
          (error as Error).message
        }`
        logDebug(warning)
      }
    }

    const connectionString = getEngine(engine).getConnectionString(
      result.config,
    )
    return {
      config: result.config,
      method: result.method,
      started,
      connectionString,
      warning,
    }
  }

  private async resetFileBasedBranch(
    branchConfig: ContainerConfig,
    parentConfig: ContainerConfig,
  ): Promise<CreateBranchResult> {
    const engine = branchConfig.engine as FileBasedEngine
    const branchEntry = await this.fileRegistryGet(engine, branchConfig.name)
    const parentEntry = await this.fileRegistryGet(engine, parentConfig.name)
    if (!branchEntry || !parentEntry) {
      throw new Error(
        'Cannot reset: registry entry missing for branch or parent.',
      )
    }
    if (!existsSync(parentEntry.filePath)) {
      throw new Error(`Parent database file not found: ${parentEntry.filePath}`)
    }

    // Drop the branch's WAL siblings along with its file. A `-wal`/`.wal` left
    // beside the fresh copy is replayed on the next open, folding the branch's
    // OWN discarded writes back over the parent's data (C-142).
    for (const stale of [
      branchEntry.filePath,
      ...walSiblings(engine, branchEntry.filePath),
    ]) {
      await rm(stale, { force: true }).catch(() => {})
    }
    const { method, warning } = await this.copyDatabaseFile({
      engine,
      sourceFile: parentEntry.filePath,
      targetFile: branchEntry.filePath,
    })
    const now = new Date().toISOString()
    await this.updateFileEntry(engine, branchConfig.name, {
      branchedAt: now,
      lastVerified: now,
    })

    const config = await containerManager.getConfig(branchConfig.name, {
      engine,
    })
    if (!config) {
      throw new Error('Failed to read reset container config')
    }
    const connectionString = getEngine(engine).getConnectionString(config)
    return { config, method, started: true, connectionString, warning }
  }

  /** Rename a branch and repoint any children's `branchParent` to the new name. */
  async renameBranch(
    oldName: string,
    newName: string,
  ): Promise<ContainerConfig> {
    const config = await containerManager.rename(oldName, newName)

    const all = await containerManager.list()
    const children = all.filter((c) => c.branchParent === oldName)
    for (const child of children) {
      if (isFileBasedEngine(child.engine)) {
        await this.updateFileEntry(
          child.engine as FileBasedEngine,
          child.name,
          {
            branchParent: newName,
          },
        )
      } else {
        await containerManager.updateConfig(child.name, {
          branchParent: newName,
        })
      }
    }
    return config
  }

  /** Lineage info for a single branch: its parent and immediate children. */
  async getBranchInfo(name: string): Promise<{
    config: ContainerConfig
    parent?: string
    children: string[]
  }> {
    const config = await containerManager.getConfig(name)
    if (!config) {
      throw new Error(`Container "${name}" not found`)
    }
    const children = await this.childrenOf(name)
    return { config, parent: config.branchParent, children }
  }

  // ---- server lifecycle helpers ----

  private async stopServer(config: ContainerConfig): Promise<void> {
    const engine = getEngine(config.engine)
    await engine.stop(config)
    await containerManager.updateConfig(config.name, { status: 'stopped' })
  }

  private async startServer(config: ContainerConfig): Promise<void> {
    const engine = getEngine(config.engine)
    await startContainerWithRetry(engine, config)
    await containerManager.updateConfig(config.name, { status: 'running' })
  }

  // ---- file-based registry helpers ----

  private async fileRegistryGet(engine: FileBasedEngine, name: string) {
    return engine === Engine.SQLite
      ? sqliteRegistry.get(name)
      : duckdbRegistry.get(name)
  }

  private async updateFileEntry(
    engine: FileBasedEngine,
    name: string,
    updates: FileEntryUpdate,
  ): Promise<void> {
    if (engine === Engine.SQLite) {
      await sqliteRegistry.update(name, updates)
    } else {
      await duckdbRegistry.update(name, updates)
    }
  }

  private async addFileEntry(
    engine: FileBasedEngine,
    entry: {
      name: string
      filePath: string
      created: string
      lastVerified?: string
      branchParent?: string
      branchedAt?: string
      gitBranch?: string
    },
  ): Promise<void> {
    if (engine === Engine.SQLite) {
      await sqliteRegistry.add(entry)
    } else {
      await duckdbRegistry.add(entry)
    }
  }
}

export const branchManager = new BranchManager()
