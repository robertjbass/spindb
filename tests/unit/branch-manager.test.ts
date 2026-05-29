import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { containerManager } from '../../core/container-manager'
import { branchManager } from '../../core/branch-manager'
import { Engine, type ContainerConfig } from '../../types'

function cfg(
  name: string,
  extra: Partial<ContainerConfig> = {},
): ContainerConfig {
  return {
    name,
    engine: Engine.PostgreSQL,
    version: '17.0.0',
    port: 5432,
    database: 'db',
    created: '2026-01-01T00:00:00.000Z',
    status: 'stopped',
    ...extra,
  }
}

describe('branchManager.getBranchTree', () => {
  afterEach(() => mock.restoreAll())

  it('builds a lineage forest from branchParent edges', async () => {
    mock.method(containerManager, 'list', async () => [
      cfg('app'),
      cfg('app-feat', { branchParent: 'app' }),
      cfg('app-feat-2', { branchParent: 'app-feat' }),
      cfg('other'),
    ])

    const tree = await branchManager.getBranchTree()

    assert.deepEqual(
      tree.map((n) => n.name),
      ['app', 'other'],
      'roots are non-branches, sorted by name',
    )
    const app = tree.find((n) => n.name === 'app')
    assert.ok(app)
    assert.equal(app.children.length, 1)
    assert.equal(app.children[0].name, 'app-feat')
    assert.equal(app.children[0].children[0].name, 'app-feat-2')
  })

  it('treats a branch whose parent was deleted as a root (orphan)', async () => {
    mock.method(containerManager, 'list', async () => [
      cfg('orphan', { branchParent: 'gone' }),
    ])

    const tree = await branchManager.getBranchTree()

    assert.equal(tree.length, 1)
    assert.equal(tree[0].name, 'orphan')
  })
})

describe('branchManager.childrenOf', () => {
  afterEach(() => mock.restoreAll())

  it('returns immediate children only', async () => {
    mock.method(containerManager, 'list', async () => [
      cfg('p'),
      cfg('c1', { branchParent: 'p' }),
      cfg('c2', { branchParent: 'p' }),
      cfg('gc', { branchParent: 'c1' }),
      cfg('x'),
    ])

    const children = await branchManager.childrenOf('p')

    assert.deepEqual(children.sort(), ['c1', 'c2'])
  })
})

describe('branchManager.deleteBranch guard', () => {
  afterEach(() => mock.restoreAll())

  it('refuses to delete a branch that has children unless cascade is set', async () => {
    mock.method(containerManager, 'getConfig', async () => cfg('p'))
    mock.method(containerManager, 'list', async () => [
      cfg('p'),
      cfg('c', { branchParent: 'p' }),
    ])

    await assert.rejects(
      () => branchManager.deleteBranch('p'),
      /child branch/,
      'should throw a guard error naming child branches',
    )
  })

  it('throws when the container does not exist', async () => {
    mock.method(containerManager, 'getConfig', async () => null)

    await assert.rejects(() => branchManager.deleteBranch('nope'), /not found/)
  })
})
