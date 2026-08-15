import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { containerManager } from '../../core/container-manager'
import { branchManager } from '../../core/branch-manager'
import { processManager } from '../../core/process-manager'
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

/**
 * CouchDB refusal placement (#276, review of #277).
 *
 * The guard first landed in `deleteBranch` by mistake, which had it backwards:
 * deletion copies nothing and must stay possible (it is how someone cleans up a
 * branch created before the refusal existed), while `resetBranch` - which
 * re-copies the parent's data directory - was left unguarded.
 *
 * Reset is the destructive one: it stops the branch AND the parent and removes
 * the branch's data directory before copying. So the refusal has to fire before
 * any of that happens, and these tests assert exactly that by spying on the
 * side-effecting collaborators.
 */
describe('branchManager CouchDB copy refusal', () => {
  afterEach(() => mock.restoreAll())

  function stubbedCollaborators(): {
    isRunning: ReturnType<typeof mock.fn>
    copy: ReturnType<typeof mock.fn>
    remove: ReturnType<typeof mock.fn>
  } {
    const isRunning = mock.fn(async () => true)
    const copy = mock.fn(async () => {
      throw new Error('copyContainerData must not be reached')
    })
    // `delete` is the real removal method on containerManager (there is no
    // `remove`), and mock.method throws on a name that is not a method.
    const remove = mock.fn(async () => {})
    mock.method(processManager, 'isRunning', isRunning)
    mock.method(containerManager, 'copyContainerData', copy)
    mock.method(containerManager, 'delete', remove)
    return { isRunning, copy, remove }
  }

  it('resetBranch refuses CouchDB without stopping or removing anything', async () => {
    mock.method(containerManager, 'getConfig', async (name: string) =>
      name === 'couch-branch'
        ? cfg('couch-branch', {
            engine: Engine.CouchDB,
            branchParent: 'couch',
            status: 'running',
          })
        : cfg('couch', { engine: Engine.CouchDB, status: 'running' }),
    )
    const spies = stubbedCollaborators()

    await assert.rejects(
      () => branchManager.resetBranch('couch-branch'),
      (error: Error) => {
        assert.equal(error.name, 'UnsupportedOperationError')
        assert.match(
          error.message,
          /^Resetting a branch is not supported for couchdb/,
        )
        return true
      },
    )

    // The whole point of guarding at the top: nothing was touched on the way out.
    assert.equal(
      spies.isRunning.mock.callCount(),
      0,
      'no server was probed or stopped',
    )
    assert.equal(spies.copy.mock.callCount(), 0, 'no data directory was copied')
    assert.equal(spies.remove.mock.callCount(), 0, 'no container was removed')
  })

  it('createBranch refuses CouchDB without stopping the source', async () => {
    mock.method(containerManager, 'getConfig', async () =>
      cfg('couch', { engine: Engine.CouchDB, status: 'running' }),
    )
    mock.method(containerManager, 'isValidName', () => true)
    mock.method(containerManager, 'exists', async () => false)
    const spies = stubbedCollaborators()

    await assert.rejects(
      () =>
        branchManager.createBranch({ source: 'couch', name: 'couch-branch' }),
      (error: Error) => {
        assert.match(error.message, /^Branching is not supported for couchdb/)
        return true
      },
    )
    assert.equal(
      spies.isRunning.mock.callCount(),
      0,
      'the source was never stopped',
    )
    assert.equal(spies.copy.mock.callCount(), 0)
  })

  it('deleteBranch still WORKS for CouchDB - deletion copies nothing', async () => {
    // The regression the misplaced guard caused: a CouchDB branch created before
    // the refusal existed could not be cleaned up.
    mock.method(containerManager, 'getConfig', async () =>
      cfg('couch-branch', {
        engine: Engine.CouchDB,
        branchParent: 'couch',
        status: 'stopped',
      }),
    )
    mock.method(containerManager, 'list', async () => [
      cfg('couch', { engine: Engine.CouchDB }),
      cfg('couch-branch', { engine: Engine.CouchDB, branchParent: 'couch' }),
    ])
    mock.method(processManager, 'isRunning', async () => false)
    const removed: string[] = []
    mock.method(containerManager, 'delete', async (name: string) => {
      removed.push(name)
    })

    const result = await branchManager.deleteBranch('couch-branch')

    assert.deepEqual(result.deleted, ['couch-branch'])
    assert.deepEqual(removed, ['couch-branch'])
  })
})
