/**
 * Unit tests for resolveWeaviateNodeIdentity.
 *
 * Weaviate's raft store (schema + shard-to-node assignments) is keyed by the
 * node name. Deriving the name from the port (`node-${port}`) meant any
 * data-dir copy landing on a new port - `spindb branch`, `spindb clone` -
 * could not load the copied raft store and came up with an EMPTY schema. The
 * identity is now persisted in `.cluster-node-name` at the container-dir
 * level, so it rides along with copies and stays stable across port changes.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveWeaviateNodeIdentity } from '../../engines/weaviate'

let containerDir: string
let dataDir: string

beforeEach(async () => {
  containerDir = await mkdtemp(join(tmpdir(), 'wv-identity-'))
  dataDir = join(containerDir, 'data')
  await mkdir(dataDir, { recursive: true })
})

afterEach(async () => {
  await rm(containerDir, { recursive: true, force: true })
})

describe('resolveWeaviateNodeIdentity', () => {
  it('derives node-<port> on a fresh container and persists it', async () => {
    const name = await resolveWeaviateNodeIdentity({
      containerDir,
      dataDir,
      port: 8080,
    })
    assert.equal(name, 'node-8080')
    const persisted = await readFile(
      join(containerDir, '.cluster-node-name'),
      'utf-8',
    )
    assert.equal(persisted, 'node-8080')
  })

  it('returns the persisted name even when the port has changed', async () => {
    await resolveWeaviateNodeIdentity({ containerDir, dataDir, port: 8080 })
    // The container moves to a new port (branch, clone, or an edit) - the
    // identity must NOT follow the port, or the raft store stops loading.
    const name = await resolveWeaviateNodeIdentity({
      containerDir,
      dataDir,
      port: 9151,
    })
    assert.equal(name, 'node-8080')
  })

  it('a copied container dir inherits the source identity (the branch case)', async () => {
    await resolveWeaviateNodeIdentity({ containerDir, dataDir, port: 8080 })
    // Simulate `spindb branch`: the whole container dir is copied, then the
    // branch starts on its own port.
    const branchDir = await mkdtemp(join(tmpdir(), 'wv-identity-branch-'))
    try {
      const branchData = join(branchDir, 'data')
      await mkdir(branchData, { recursive: true })
      await writeFile(
        join(branchDir, '.cluster-node-name'),
        await readFile(join(containerDir, '.cluster-node-name'), 'utf-8'),
      )
      const branchName = await resolveWeaviateNodeIdentity({
        containerDir: branchDir,
        dataDir: branchData,
        port: 9151,
      })
      assert.equal(branchName, 'node-8080', 'branch must keep the parent name')
    } finally {
      await rm(branchDir, { recursive: true, force: true })
    }
  })

  it('legacy container with raft state: derives the name from the retired identity tracker', async () => {
    // A pre-fix container that ran on port 8080, has raft state owned by
    // node-8080, and whose port has since changed to 9151. The retired
    // `.last-cluster-identity` recorded bind:port; the raft store must keep
    // loading, so the OLD port wins.
    await mkdir(join(dataDir, 'raft'), { recursive: true })
    await writeFile(
      join(containerDir, '.last-cluster-identity'),
      '0.0.0.0:8080',
    )
    const name = await resolveWeaviateNodeIdentity({
      containerDir,
      dataDir,
      port: 9151,
    })
    assert.equal(name, 'node-8080')
    // And it is now persisted, so later starts stop consulting the tracker.
    assert.equal(
      (
        await readFile(join(containerDir, '.cluster-node-name'), 'utf-8')
      ).trim(),
      'node-8080',
    )
  })

  it('legacy tracker without raft state is ignored (nothing to preserve)', async () => {
    await writeFile(
      join(containerDir, '.last-cluster-identity'),
      '0.0.0.0:8080',
    )
    const name = await resolveWeaviateNodeIdentity({
      containerDir,
      dataDir,
      port: 9151,
    })
    assert.equal(name, 'node-9151')
  })

  it('malformed tracker falls back to the port-derived name', async () => {
    await mkdir(join(dataDir, 'raft'), { recursive: true })
    await writeFile(join(containerDir, '.last-cluster-identity'), 'garbage')
    const name = await resolveWeaviateNodeIdentity({
      containerDir,
      dataDir,
      port: 9151,
    })
    assert.equal(name, 'node-9151')
  })

  it('an empty persisted file is treated as absent', async () => {
    await writeFile(join(containerDir, '.cluster-node-name'), '')
    const name = await resolveWeaviateNodeIdentity({
      containerDir,
      dataDir,
      port: 8080,
    })
    assert.equal(name, 'node-8080')
  })
})
