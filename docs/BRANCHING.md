# Database Branching

SpinDB can **branch** a database the way [Neon](https://neon.tech) and Vercel do — fork it instantly into an independent copy you can diverge, throw away, or reset — but locally and for **every engine SpinDB supports**.

## How it works (and why it's instant)

Neon makes branching instant by storing data in a custom copy-on-write (CoW) storage layer. We can't rebuild 21 storage engines, so SpinDB gets the same effect from a layer that sits **below** the database and is therefore engine-agnostic: the **filesystem**.

A branch is a copy of the container's data directory created with a filesystem **reflink / clonefile** instead of a byte-for-byte copy. The branch shares disk blocks with its source until one side is written, so creating it is effectively instant and uses almost no extra space — until the branch and its source diverge.

Where the filesystem can't do CoW, SpinDB transparently falls back to a full copy. The result is always correct; only the speed/space benefit depends on the filesystem:

| Host filesystem | Branch is… |
| --- | --- |
| **APFS** (every modern macOS volume) | instant, copy-on-write |
| **Btrfs**, **XFS** (with reflink), **ZFS** (Linux) | instant, copy-on-write |
| **ext4** (common Linux default), **NTFS** (Windows) | a full copy (works, but not instant/free) |

`spindb branch … --json` reports `"method": "reflink"` (CoW) or `"method": "copy"` (full copy) so you always know which happened.

## Live sources: auto stop → snapshot → restart

To take a consistent snapshot, a **running** source is briefly stopped, its data directory is cloned, and it is **restarted automatically** — minimizing downtime. This works uniformly across every engine and OS. File-based engines (SQLite/DuckDB) have no server, so there's no stop/restart.

## `branch` vs `clone`

Both fork a container, but they're different tools:

- **`spindb clone`** — an explicit, full byte-for-byte copy. Requires the source to be stopped. No lineage beyond `clonedFrom`.
- **`spindb branch`** — a copy-on-write fork (instant where supported) that records its **parent**, so branches form a lineage tree, can be **reset** to their parent, and auto-handle a running source.

## Command reference

```bash
# Create a branch (auto-starts it; auto stop/restart of a running source)
spindb branch <source> [name]
spindb branch myapp myapp-feature
spindb branch myapp myapp-feature --no-start      # create but don't start
spindb branch myapp myapp-feature --port 6000     # run on a specific port
spindb branch myapp myapp-feature --json          # scriptable output

# Inspect lineage
spindb branch list                 # the branch tree
spindb branch list --json
spindb branch info myapp-feature

# Reset a branch back to its parent's current state (discards the branch's changes)
spindb branch reset myapp-feature
spindb branch reset myapp-feature --force          # skip confirmation

# Rename (children are repointed automatically)
spindb branch rename myapp-feature myapp-exp

# Delete
spindb branch delete myapp-feature                 # refuses if it has children
spindb branch delete myapp --cascade               # delete a branch and its subtree
```

Lineage also shows up in the rest of the CLI: `spindb info <name>` prints **Branched From / Branched At**, and `spindb list --json` includes the `branchParent` field. Branches are normal containers — `start`, `stop`, `query`, `backup`, etc. all work on them.

### Interactive menu

In `spindb` (interactive), a container's action menu includes **Branch container** (works whether or not it's running) and, for containers that are themselves branches, **Reset branch to "&lt;parent&gt;"**.

## `--json` contract (for consumers)

`spindb branch <source> <name> --json` returns:

```json
{
  "success": true,
  "source": "myapp",
  "name": "myapp-feature",
  "engine": "postgresql",
  "port": 5455,
  "started": true,
  "method": "reflink",
  "branchParent": "myapp",
  "connectionString": "postgresql://postgres@127.0.0.1:5455/myapp",
  "warning": "optional non-fatal note (e.g. source failed to restart)"
}
```

`branch list --json` returns the lineage forest (`{ name, engine, status, port, branchParent, branchedAt, gitBranch, children: [...] }`). Errors are `{ "error": "..." }` with a non-zero exit code, like every other SpinDB command.

## Per-engine notes

- **SQLite / DuckDB** — the best case: a branch is a clone of the single database file, registered as a new entry. Instant on APFS.
- **PostgreSQL, MySQL, MariaDB, MongoDB, FerretDB, Redis, Valkey, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB, LibSQL** — the data directory is cloned and the container starts on a fresh port.
- **ClickHouse** — `config.xml` embeds absolute paths, so it is regenerated for the branch's name/port (handled automatically).
- **Weaviate** — RAFT cluster state is keyed to the port; the branch starts on a new port and Weaviate's startup re-initializes its single-node cluster automatically.
- **Linked / remote databases** (`spindb link`) — cannot be branched locally (there's no local data dir). Use `spindb backup` + `spindb restore` to copy data locally first.

## Limitations

- **No time-travel.** You can branch the *current* state, not an arbitrary point in history — that would require per-engine WAL archiving / point-in-time recovery. (Future, PostgreSQL-first.)
- **No merge.** Databases don't merge cleanly; branches are independent forks.
- **Cloud filesystems.** Instant branching needs a CoW filesystem on the host. Managed/cloud volumes on ext4 will fall back to a full copy.

## Cloud & desktop

Branching lives entirely in SpinDB so every consumer gets it for free: **layerbase-desktop** calls `spindb branch` over IPC, and **layerbase-cloud** execs it inside the user's container. To deliver *instant* branching in the cloud, provision a copy-on-write filesystem (ZFS/Btrfs/XFS-reflink) for the data volumes — otherwise branches there are full copies.

## Git-driven branching (planned)

A planned framework will tie your **git branch** to a **database branch** automatically (Neon/Vercel-style): a `post-checkout` hook swaps the active database branch onto a stable port as you switch git branches, so your `DATABASE_URL` never changes. See the roadmap in [TODO.md](../TODO.md).
