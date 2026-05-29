# Integrating branching into Layerbase Desktop & Cloud

Database branching lives entirely in SpinDB (see [BRANCHING.md](BRANCHING.md)). Consumers never reimplement the logic — they call the `spindb branch …` commands and parse the `--json` output. This guide is the concrete playbook for **layerbase-desktop** and **layerbase-cloud** (Phase 3 of the branching rollout).

## The contract (recap)

Every branch subcommand supports `--json`. Success is a JSON object; errors are `{ "error": "..." }` with a non-zero exit code. The shapes are documented in [BRANCHING.md → `--json` contract](BRANCHING.md#--json-contract-for-consumers). The two you'll use most:

- `spindb branch <source> <name> --json` → `{ success, source, name, engine, port, started, method, branchParent, connectionString, warning? }`
- `spindb branch list --json` → the lineage forest: `[{ name, engine, status, port, branchParent, branchedAt, gitBranch, children: [...] }]`

`method` is `"reflink"` (instant copy-on-write) or `"copy"` (full byte copy) — surface it so users/ops understand cost.

---

## layerbase-desktop

Desktop already shells out to spindb and parses `--json` via `spindbJson<T>()` in `src/main/ipc/spindb.ts`, and has a `cloneContainer()` handler + a clone modal. Branching mirrors that exactly.

**1. IPC handlers** (`src/main/ipc/spindb.ts`) — add alongside `cloneContainer`:

```ts
export async function branchContainer(
  source: string,
  name: string,
  opts?: { noStart?: boolean; port?: number },
): Promise<BranchResult> {
  const args = ['branch', source, name, '--json']
  if (opts?.noStart) args.push('--no-start')
  if (opts?.port) args.push('--port', String(opts.port))
  const result = await spindbJson<BranchResult>(args, { runtime: resolveContainerRuntime(source) })
  containerEvents.emit('containers-changed')
  return result
}

export const listBranches = () => spindbJson<BranchNode[]>(['branch', 'list', '--json'])
export const branchInfo  = (name: string) => spindbJson(['branch', 'info', name, '--json'])
export async function resetBranch(name: string) {
  const r = await spindbJson(['branch', 'reset', name, '--force', '--json'])
  containerEvents.emit('containers-changed'); return r
}
export async function deleteBranch(name: string, cascade = false) {
  const args = ['branch', 'delete', name, '--force', '--json']
  if (cascade) args.push('--cascade')
  const r = await spindbJson(args); containerEvents.emit('containers-changed'); return r
}
```

**2. Emit `containers-changed`** after every mutating op (branch/reset/delete) so the renderer refreshes — same as `cloneContainer`.

**3. UI** (`src/renderer/pages/containers.tsx`):
- A **Branch** modal (clone the clone modal): source = the selected container, default name `${source}-branch`, optional "don't start" / port.
- Show lineage in the container list: a container with `branchParent` renders nested/indented under its parent (the `branch list --json` forest gives you the tree directly).
- Per-container actions: **Branch**, **Reset to parent** (only when `branchParent` is set), and a **cascade** confirm when deleting a container that has children.

**4. Git-driven branching** is a local-terminal workflow (a `post-checkout` hook). Desktop can expose `branch init` / `branch status` for visibility, but the hook itself targets CLI users — don't try to drive `sync` from the GUI on every git operation.

**Don't reach into spindb internals.** No data-dir copying or registry writes in desktop — only `spindb branch …` calls. (Ecosystem invariant: thin desktop wrapper.)

---

## layerbase-cloud

Cloud runs spindb inside the user's container via `runtime.exec(... 'gosu', 'layerbase', 'spindb', …)` (`src/runtime/spindb.ts`) and exposes HTTP handlers in `src/api/databases.ts`.

**1. Endpoint** — add `POST /v1/databases/:id/branch` (mirror `handleCreate`):

```ts
// 1. resolve source database -> its spindb container name + user container
// 2. allocate a port for the branch from the user's port block (same as create)
// 3. exec the branch in the user container:
const r = await runtime.exec(containerId, [
  'gosu', 'layerbase', 'spindb', 'branch', sourceName, branchName,
  '--port', String(port), '--json',
])
if (r.exitCode !== 0) throw new Error(`spindb branch failed: ${r.stderr || r.stdout}`)
const branch = JSON.parse(r.stdout)   // { name, port, connectionString, method, ... }
// 4. persist a database record for the branch; return its connection string
```

- **Port allocation:** allocate from the user's port block exactly like `create` — pass `--port` so the branch is deterministic (don't let it auto-pick).
- **Reset/delete:** `spindb branch reset <name> --force --json` and `spindb branch delete <name> --force [--cascade] --json`, then update your records.

**2. ⚠️ Filesystem matters for "instant".** A branch is only instant + near-zero-space on a copy-on-write filesystem. **Hetzner volumes are typically ext4**, where spindb transparently falls back to a **full copy** (correct, but as slow/large as a backup+restore). To deliver instant cloud branches, provision a **CoW filesystem (ZFS / Btrfs / XFS with reflink)** for the user data volumes. The `method` field (`"reflink"` vs `"copy"`) in the branch result tells you which happened — log/meter on it.

**3. The git-hook framework does NOT apply to cloud.** There's no git repo driving the container; cloud uses the `branch` primitive directly (`init`/`sync`/`hooks` are local-dev only).

**4. Normalization:** the `connectionString` from `spindb branch` is already engine-correct; reuse whatever `handleCreate` does for connection-string handling.

---

## Verifying an integration

- Drive each path against a real container (`branch`, `branch list`, `reset`, `delete --cascade`) and assert on the parsed `--json`, not on stdout text.
- Assert `branchParent` lineage and that `method` is present.
- Cloud: verify behavior on **both** an ext4 volume (`method: "copy"`) and a CoW volume (`method: "reflink"`).

When these land, update the Phase 3 checklist in [TODO.md](../TODO.md).
