import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import {
  sanitizeBranchName,
  containerNameForBranch,
  installHooks,
  uninstallHooks,
  hooksInstalled,
  loadConfig,
  type RepoBranchConfig,
} from '../../core/git-branch-sync'
import { Engine } from '../../types'

const MARKER = '# >>> spindb branch sync (managed) >>>'

describe('git-branch-sync: sanitizeBranchName', () => {
  it('keeps simple names', () => {
    assert.equal(sanitizeBranchName('main'), 'main')
    assert.equal(sanitizeBranchName('develop'), 'develop')
  })

  it('replaces slashes, dots, and underscores with dashes', () => {
    assert.equal(sanitizeBranchName('feature/foo.bar'), 'feature-foo-bar')
    assert.equal(sanitizeBranchName('JIRA-123/thing'), 'JIRA-123-thing')
    assert.equal(sanitizeBranchName('a//b__c'), 'a-b-c')
  })

  it('trims and collapses separators', () => {
    assert.equal(sanitizeBranchName('--weird--'), 'weird')
  })

  it('falls back to "branch" when nothing usable remains', () => {
    assert.equal(sanitizeBranchName('///'), 'branch')
  })
})

describe('git-branch-sync: containerNameForBranch', () => {
  const config: RepoBranchConfig = {
    version: 1,
    baseContainer: 'app',
    engine: Engine.PostgreSQL,
    stablePort: 5432,
    mainBranch: 'main',
  }

  it('maps the main branch to the base container', () => {
    assert.equal(containerNameForBranch(config, 'main'), 'app')
  })

  it('maps a feature branch to a sanitized child name', () => {
    assert.equal(containerNameForBranch(config, 'feature/x'), 'app__feature-x')
    assert.equal(
      containerNameForBranch(config, 'fix/bug-42'),
      'app__fix-bug-42',
    )
  })
})

describe('git-branch-sync: post-checkout hook management', () => {
  let repo: string

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'spindb-git-'))
    execFileSync('git', ['init', '-q', repo])
  })

  after(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  const hookFile = () => join(repo, '.git', 'hooks', 'post-checkout')

  it('installs a post-checkout hook with the managed marker', async () => {
    await installHooks(repo)
    assert.equal(await hooksInstalled(repo), true)
    assert.ok(existsSync(hookFile()))
    const content = await readFile(hookFile(), 'utf8')
    assert.ok(content.includes('spindb branch sync --git-checkout'))
    if (process.platform !== 'win32') {
      const mode = (await stat(hookFile())).mode
      assert.ok(mode & 0o100, 'hook should be executable')
    }
  })

  it('is idempotent (a single managed block after repeated installs)', async () => {
    await installHooks(repo)
    await installHooks(repo)
    const content = await readFile(hookFile(), 'utf8')
    const occurrences = content.split(MARKER).length - 1
    assert.equal(occurrences, 1)
  })

  it('preserves a pre-existing hook (chain-safe)', async () => {
    await uninstallHooks(repo)
    await writeFile(hookFile(), '#!/bin/sh\necho "my custom hook"\n')
    await installHooks(repo)
    const content = await readFile(hookFile(), 'utf8')
    assert.ok(content.includes('my custom hook'), 'existing hook body kept')
    assert.ok(content.includes(MARKER), 'managed block added')
  })

  it('uninstall removes the managed block but keeps the custom hook', async () => {
    // Self-contained: seed a hook with both a custom body and our managed block.
    await writeFile(hookFile(), '#!/bin/sh\necho "my custom hook"\n')
    await installHooks(repo)
    await uninstallHooks(repo)
    const content = await readFile(hookFile(), 'utf8')
    assert.ok(content.includes('my custom hook'))
    assert.ok(!content.includes(MARKER))
    assert.equal(await hooksInstalled(repo), false)
  })
})

describe('git-branch-sync: repo config', () => {
  it('loads a written config', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'spindb-git-'))
    try {
      await mkdir(join(repo, '.spindb'), { recursive: true })
      await writeFile(
        join(repo, '.spindb', 'branch.json'),
        JSON.stringify({
          version: 1,
          baseContainer: 'app',
          engine: 'postgresql',
          stablePort: 5432,
          mainBranch: 'main',
        }),
      )
      const loaded = await loadConfig(repo)
      assert.equal(loaded?.baseContainer, 'app')
      assert.equal(loaded?.stablePort, 5432)
      assert.equal(loaded?.mainBranch, 'main')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('returns null when no config exists', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'spindb-git-'))
    try {
      assert.equal(await loadConfig(repo), null)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
