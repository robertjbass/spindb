/**
 * Git-driven database branching.
 *
 * Ties a git branch to a database branch the way Neon/Vercel preview branches
 * do, but locally: as you switch git branches, the matching database branch is
 * swapped onto a **stable port** so your app's connection string never changes.
 *
 * Model (chosen with the user): one database branch is live at a time on a
 * fixed port (the base container's port). On `git checkout`, a `post-checkout`
 * hook runs `spindb branch sync`, which:
 *   1. computes the container name for the current git branch (deterministic),
 *   2. creates it from the base (copy-on-write) if it doesn't exist yet,
 *   3. stops whichever repo branch is currently on the stable port,
 *   4. starts the target on the stable port.
 *
 * All git-branch databases carry the same `stablePort` in their container.json;
 * since spindb only treats *running* containers as occupying a port, the
 * stopped siblings sharing a port is fine.
 *
 * State is intentionally minimal: the only persisted file is
 * `.spindb/branch.json` at the repo root (shareable). Everything else
 * (which branches exist, which is active) is derived from spindb's container
 * registry, so there's no machine-local bookkeeping to drift.
 *
 * Server engines only — the stable-port model doesn't apply to file-based
 * engines (SQLite/DuckDB), which have no port.
 */

import { existsSync } from 'fs'
import { mkdir, readFile, writeFile, rm, chmod } from 'fs/promises'
import { join, isAbsolute } from 'path'
import { spawnAsync } from './spawn-utils'
import { containerManager } from './container-manager'
import { processManager } from './process-manager'
import { startContainerWithRetry } from './start-with-retry'
import { branchManager } from './branch-manager'
import { getEngine } from '../engines'
import { logDebug } from './error-handler'
import type { ContainerConfig, Engine } from '../types'
import { isFileBasedEngine, isRemoteContainer } from '../types'

export type RepoBranchConfig = {
  version: 1
  /** The container that backs this repo; the git "main" branch maps to it. */
  baseContainer: string
  engine: Engine
  /** Fixed port the active branch always listens on (= base's port at init). */
  stablePort: number
  /** Git branch that maps to the base container directly (e.g. 'main'). */
  mainBranch: string
}

const HOOK_START = '# >>> spindb branch sync (managed) >>>'
const HOOK_END = '# <<< spindb branch sync (managed) <<<'

// post-checkout receives: $1 prev HEAD, $2 new HEAD, $3 flag (1 = branch checkout).
const POST_CHECKOUT_BLOCK = [
  HOOK_START,
  '# Swap the active spindb database branch to match the checked-out git branch.',
  'if [ "$3" = "1" ]; then',
  '  if command -v spindb >/dev/null 2>&1; then',
  '    spindb branch sync --git-checkout >/dev/null 2>&1 || true',
  '  fi',
  'fi',
  HOOK_END,
].join('\n')

// ---- git helpers ----

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await spawnAsync('git', args, { cwd })
  return stdout.trim()
}

export async function findRepoRoot(
  cwd: string = process.cwd(),
): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

async function listLocalBranches(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, [
    'branch',
    '--list',
    '--format=%(refname:short)',
  ])
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---- repo config (.spindb/branch.json) ----

function configDir(repoRoot: string): string {
  return join(repoRoot, '.spindb')
}

function configPath(repoRoot: string): string {
  return join(configDir(repoRoot), 'branch.json')
}

export async function loadConfig(
  repoRoot: string,
): Promise<RepoBranchConfig | null> {
  const path = configPath(repoRoot)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RepoBranchConfig
  } catch (error) {
    throw new Error(
      `Failed to parse ${path}: ${(error as Error).message}. Re-run "spindb branch init".`,
    )
  }
}

async function saveConfig(
  repoRoot: string,
  config: RepoBranchConfig,
): Promise<void> {
  await mkdir(configDir(repoRoot), { recursive: true })
  await writeFile(configPath(repoRoot), JSON.stringify(config, null, 2) + '\n')
}

// ---- naming ----

/**
 * Turn a git branch name into the alphanumeric-with-dashes suffix used in a
 * container name. `feature/foo.bar` -> `feature-foo-bar`.
 */
export function sanitizeBranchName(gitBranch: string): string {
  const cleaned = gitBranch
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'branch'
}

/** The container name for a given git branch (the base for the main branch). */
export function containerNameForBranch(
  config: RepoBranchConfig,
  gitBranch: string,
): string {
  if (gitBranch === config.mainBranch) return config.baseContainer
  return `${config.baseContainer}__${sanitizeBranchName(gitBranch)}`
}

// ---- post-checkout hook management (chain-safe) ----

async function hooksDir(repoRoot: string): Promise<string> {
  const path = await git(repoRoot, ['rev-parse', '--git-path', 'hooks'])
  return isAbsolute(path) ? path : join(repoRoot, path)
}

function stripManagedBlock(content: string): string {
  const start = content.indexOf(HOOK_START)
  const end = content.indexOf(HOOK_END)
  if (start === -1 || end === -1) return content
  const before = content.slice(0, start).replace(/\n+$/, '')
  const after = content.slice(end + HOOK_END.length).replace(/^\n+/, '')
  return [before, after].filter(Boolean).join('\n\n')
}

export async function hooksInstalled(repoRoot: string): Promise<boolean> {
  const file = join(await hooksDir(repoRoot), 'post-checkout')
  if (!existsSync(file)) return false
  return (await readFile(file, 'utf8')).includes(HOOK_START)
}

export async function installHooks(repoRoot: string): Promise<void> {
  const dir = await hooksDir(repoRoot)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'post-checkout')

  let existing = existsSync(file) ? await readFile(file, 'utf8') : ''
  // Drop any previous managed block so re-installs are idempotent.
  existing = stripManagedBlock(existing).trim()

  let content: string
  if (existing === '') {
    content = `#!/bin/sh\n${POST_CHECKOUT_BLOCK}\n`
  } else if (existing.startsWith('#!')) {
    // Preserve the user's existing hook; append our managed block.
    content = `${existing}\n\n${POST_CHECKOUT_BLOCK}\n`
  } else {
    content = `#!/bin/sh\n${existing}\n\n${POST_CHECKOUT_BLOCK}\n`
  }

  await writeFile(file, content)
  await chmod(file, 0o755).catch(() => {})
}

export async function uninstallHooks(repoRoot: string): Promise<void> {
  const file = join(await hooksDir(repoRoot), 'post-checkout')
  if (!existsSync(file)) return
  const content = await readFile(file, 'utf8')
  if (!content.includes(HOOK_START)) return

  const remaining = stripManagedBlock(content)
  // If nothing but a shebang/whitespace is left, remove the file entirely.
  if (remaining.replace(/^#!.*$/m, '').trim() === '') {
    await rm(file, { force: true })
  } else {
    await writeFile(
      file,
      remaining.endsWith('\n') ? remaining : `${remaining}\n`,
    )
  }
}

// ---- container lifecycle (mirrors branch-manager; kept local to avoid a cycle) ----

async function startContainer(config: ContainerConfig): Promise<void> {
  await startContainerWithRetry(getEngine(config.engine), config)
  await containerManager.updateConfig(config.name, { status: 'running' })
}

async function stopContainer(config: ContainerConfig): Promise<void> {
  await getEngine(config.engine).stop(config)
  await containerManager.updateConfig(config.name, { status: 'stopped' })
}

/** The base plus all git-managed branches forked from it. */
async function repoContainers(
  config: RepoBranchConfig,
): Promise<ContainerConfig[]> {
  const all = await containerManager.list()
  return all.filter(
    (c) =>
      c.name === config.baseContainer ||
      (c.branchParent === config.baseContainer && Boolean(c.gitBranch)),
  )
}

// ---- public operations ----

export async function initRepo(options: {
  baseContainer: string
  cwd?: string
}): Promise<{ repoRoot: string; config: RepoBranchConfig }> {
  const cwd = options.cwd ?? process.cwd()
  const repoRoot = await findRepoRoot(cwd)
  if (!repoRoot) {
    throw new Error(
      'Not a git repository. Run "spindb branch init" inside one.',
    )
  }

  const base = await containerManager.getConfig(options.baseContainer)
  if (!base) {
    throw new Error(`Container "${options.baseContainer}" not found`)
  }
  if (isRemoteContainer(base)) {
    throw new Error('Cannot use a linked remote container as a branch base.')
  }
  if (isFileBasedEngine(base.engine)) {
    throw new Error(
      'Git branching uses a stable port and is not applicable to file-based engines (SQLite/DuckDB).',
    )
  }
  if (!base.port || base.port <= 0) {
    throw new Error(
      `Container "${options.baseContainer}" has no port to use as the stable port.`,
    )
  }

  const mainBranch = await getCurrentBranch(repoRoot)
  const config: RepoBranchConfig = {
    version: 1,
    baseContainer: base.name,
    engine: base.engine,
    stablePort: base.port,
    mainBranch,
  }
  await saveConfig(repoRoot, config)
  await installHooks(repoRoot)
  return { repoRoot, config }
}

export type SyncResult = {
  gitBranch: string
  container: string
  isBase: boolean
  created: boolean
  connectionString: string
}

export async function sync(options: {
  cwd?: string
  fromHook?: boolean
}): Promise<SyncResult> {
  const cwd = options.cwd ?? process.cwd()
  const repoRoot = await findRepoRoot(cwd)
  if (!repoRoot) {
    throw new Error('Not a git repository.')
  }
  const config = await loadConfig(repoRoot)
  if (!config) {
    throw new Error(
      'No branch config for this repo. Run "spindb branch init --base <container>" first.',
    )
  }

  if (!(await containerManager.exists(config.baseContainer))) {
    throw new Error(`Base container "${config.baseContainer}" not found.`)
  }

  const gitBranch = await getCurrentBranch(repoRoot)
  const target = containerNameForBranch(config, gitBranch)
  const isBase = target === config.baseContainer

  // Create the branch from the base on first checkout of this git branch.
  let created = false
  if (
    !isBase &&
    !(await containerManager.exists(target, { engine: config.engine }))
  ) {
    await branchManager.createBranch({
      source: config.baseContainer,
      name: target,
      port: config.stablePort,
      start: false,
      gitBranch,
    })
    created = true
  }

  // Stop whichever repo branch is currently on the stable port (not the target).
  for (const c of await repoContainers(config)) {
    if (c.name === target) continue
    if (await processManager.isRunning(c.name, { engine: c.engine })) {
      await stopContainer(c)
    }
  }

  // Start the target on the stable port.
  const targetConfig = await containerManager.getConfig(target)
  if (!targetConfig) {
    throw new Error(`Target container "${target}" not found after sync.`)
  }
  const running = await processManager.isRunning(target, {
    engine: targetConfig.engine,
  })
  if (!running) {
    await startContainer(targetConfig)
  }

  logDebug(
    `git-branch-sync: ${gitBranch} -> ${target} on port ${config.stablePort}`,
  )
  return {
    gitBranch,
    container: target,
    isBase,
    created,
    connectionString: getEngine(targetConfig.engine).getConnectionString(
      targetConfig,
    ),
  }
}

export async function prune(options: {
  cwd?: string
}): Promise<{ deleted: string[] }> {
  const cwd = options.cwd ?? process.cwd()
  const repoRoot = await findRepoRoot(cwd)
  if (!repoRoot) {
    throw new Error('Not a git repository.')
  }
  const config = await loadConfig(repoRoot)
  if (!config) {
    throw new Error('No branch config for this repo. Run "spindb branch init".')
  }

  const gitBranches = new Set(await listLocalBranches(repoRoot))
  const activeContainer = containerNameForBranch(
    config,
    await getCurrentBranch(repoRoot),
  )

  const deleted: string[] = []
  for (const c of await repoContainers(config)) {
    if (c.name === config.baseContainer) continue // never prune the base
    if (c.name === activeContainer) continue // never prune the active branch
    if (!c.gitBranch) continue
    if (!gitBranches.has(c.gitBranch)) {
      await branchManager.deleteBranch(c.name, { cascade: true })
      deleted.push(c.name)
    }
  }
  return { deleted }
}

export type GitBranchStatus = {
  repoRoot: string
  config: RepoBranchConfig
  gitBranch: string
  target: string
  hooksInstalled: boolean
  active?: string
}

export async function status(options: {
  cwd?: string
}): Promise<GitBranchStatus | null> {
  const cwd = options.cwd ?? process.cwd()
  const repoRoot = await findRepoRoot(cwd)
  if (!repoRoot) return null
  const config = await loadConfig(repoRoot)
  if (!config) return null

  const gitBranch = await getCurrentBranch(repoRoot)
  let active: string | undefined
  for (const c of await repoContainers(config)) {
    if (await processManager.isRunning(c.name, { engine: c.engine })) {
      active = c.name
      break
    }
  }

  return {
    repoRoot,
    config,
    gitBranch,
    target: containerNameForBranch(config, gitBranch),
    hooksInstalled: await hooksInstalled(repoRoot),
    active,
  }
}
