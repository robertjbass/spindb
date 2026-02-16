# Weaviate Engine Implementation

## Overview

Weaviate is an AI-native vector database with REST and gRPC APIs. Like Qdrant and Meilisearch, it uses HTTP for all operations. Uses classes/collections instead of traditional databases.

## Platform Support

| Platform | Architecture | Status | Notes |
|----------|--------------|--------|-------|
| darwin | x64 | Supported | Uses hostdb binaries |
| darwin | arm64 | Supported | Uses hostdb binaries (Apple Silicon) |
| linux | x64 | Supported | Uses hostdb binaries |
| linux | arm64 | Supported | Uses hostdb binaries |
| win32 | x64 | Supported | Uses hostdb binaries |

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz`
- **Windows**: `zip`

### Archive Structure
```
weaviate/
└── bin/
    └── weaviate           # Server binary
```

### Version Map Sync

```typescript
export const WEAVIATE_VERSION_MAP: Record<string, string> = {
  '1': '1.35.7',
}
```

## Implementation Details

### Binary Manager

Weaviate uses `BaseBinaryManager` with a custom `verify()` override:

```typescript
// Weaviate doesn't support --version (as of v1.35.x)
// Verification just checks binary existence
async verify(): Promise<boolean> {
  return existsSync(binaryPath)
}
```

See: https://github.com/weaviate/weaviate/issues/6571

### Version Parsing

Not applicable for current version (no `--version` flag). The `parseVersionFromOutput` method is implemented for forward compatibility when the flag is added:
- **Parse pattern**: `/(?:weaviate\s+)?v?(\d+\.\d+\.\d+)/`

### REST API Engine

Weaviate is a **REST API engine** - it doesn't have a CLI shell:
- `spindb run` is **NOT applicable**
- `spindb connect` opens the web dashboard in browser
- All data operations use HTTP REST API

### Dual Ports

Weaviate uses two ports:
- **HTTP Port** (default 8080): REST API
- **gRPC Port** (default 8081): gRPC API (typically HTTP + 1)

### Default Configuration

- **Default HTTP Port**: 8080 (auto-increments on conflict)
- **gRPC Port**: HTTP port + 1
- **Health Endpoint**: `/v1/.well-known/ready`
- **Schema Endpoint**: `/v1/schema`
- **PID File**: `weaviate.pid` in container directory

### Environment Variable Configuration

Weaviate uses environment variables (not a config file):

```bash
PERSISTENCE_DATA_PATH=/path/to/data
BACKUP_FILESYSTEM_PATH=/path/to/data/backups
QUERY_DEFAULTS_LIMIT=25
AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true
DEFAULT_VECTORIZER_MODULE=none
ENABLE_MODULES=backup-filesystem
GRPC_PORT=8081
CLUSTER_HOSTNAME=node-{port}        # Must be unique per container
CLUSTER_GOSSIP_BIND_PORT={port+100}  # Memberlist gossip (default 7946)
CLUSTER_DATA_BIND_PORT={port+101}    # Memberlist data (default 7947)
RAFT_PORT={port+200}                 # Raft consensus (default 8300)
RAFT_INTERNAL_RPC_PORT={port+201}    # Raft internal RPC (default 8301)
```

### Internal Cluster Ports

Weaviate uses 4 internal cluster ports in addition to HTTP and gRPC. These **must be unique per container** or Weaviate will fail to start (or silently conflict with other instances):

| Port | Default | SpinDB Formula | Purpose |
|------|---------|----------------|---------|
| HTTP | 8080 | `{port}` | REST API |
| gRPC | 8081 | `{port}+1` | gRPC API |
| Gossip | 7946 | `{port}+100` | Memberlist gossip |
| Data | 7947 | `{port}+101` | Memberlist data |
| Raft | 8300 | `{port}+200` | Raft consensus |
| Raft RPC | 8301 | `{port}+201` | Raft internal RPC |

### Connection String Format

```
http://127.0.0.1:{port}
```

### Web Dashboard

The `connect` command opens the root URL in the default browser:
```
http://localhost:{port}/
```

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| snapshot | `.snapshot` | REST API | Weaviate filesystem backup |

### Backup API

Backup and restore use Weaviate's filesystem backup endpoints:
- `POST /v1/backups/filesystem` - Create backup (with status polling)
- `GET /v1/backups/filesystem/{id}` - Check backup status
- `POST /v1/backups/filesystem/{id}/restore` - Restore backup

### Backup Flow

1. `BACKUP_FILESYSTEM_PATH` env var points to `{dataDir}/backups`
2. `ENABLE_MODULES=backup-filesystem` must be set (or backup API returns 404)
3. Trigger backup via `POST /v1/backups/filesystem` with `{ id: "spindb-backup-{ts}" }`
4. Poll status via `GET /v1/backups/filesystem/{id}` until `SUCCESS`
5. Copy backup **directory** (not a single file) from `{backupsDir}/{id}/` to output path

### Restore Flow

1. Copy backup directory into target container's `{backupsDir}/{backupId}/`
2. **The directory name MUST match the internal backup ID** stored in `backup_config.json` inside the backup. Weaviate validates this and returns 422 on mismatch.
3. Start Weaviate
4. Trigger restore via `POST /v1/backups/filesystem/{backupId}/restore`
5. If restoring to a container with a different `CLUSTER_HOSTNAME`, pass `node_mapping` in the request body:
   ```json
   { "node_mapping": { "node-8080": "node-9090" } }
   ```
6. Poll restore status until `SUCCESS`

## Integration Test Notes

### REST API Testing

Integration tests use `fetch()` for operations, not CLI tools.

### Test Ports

```typescript
weaviate: { base: 8090, clone: 8092, renamed: 8091 }
```

## Docker E2E Test Notes

Weaviate Docker E2E uses `curl` for all operations:

```bash
# Health check
curl http://localhost:8080/v1/.well-known/ready

# Create class
curl -X POST http://localhost:8080/v1/schema \
  -H 'Content-Type: application/json' \
  -d '{"class":"TestVectors","vectorizer":"none","properties":[...]}'

# Insert objects (batch)
curl -X POST http://localhost:8080/v1/batch/objects \
  -H 'Content-Type: application/json' \
  -d '{"objects":[...]}'
```

## Known Issues & Gotchas

### 1. No --version Flag

Weaviate binary doesn't support `--version` as of v1.35.x. Tracked in [weaviate/weaviate#6571](https://github.com/weaviate/weaviate/issues/6571). Binary verification only checks file existence. Same pattern as CouchDB.

### 2. No CLI Shell

`spindb run` does nothing for Weaviate. Use the REST API or web dashboard.

### 3. Vector Database Semantics

Weaviate uses "classes" (or "collections") instead of "databases". Operations are vector-centric:
- Create classes with property schemas
- Insert objects with optional vectors
- Search by vector similarity or filters

### 4. Internal Cluster Ports Must Be Unique

Weaviate binds 4 internal ports (gossip 7946, data 7947, raft 8300, raft RPC 8301) by default. Running multiple Weaviate containers without unique ports causes silent conflicts or startup failures. SpinDB derives unique ports from the HTTP port (see "Internal Cluster Ports" above).

### 5. ENABLE_MODULES Required for Backup

`ENABLE_MODULES=backup-filesystem` must be set at startup or the backup/restore API endpoints return 404.

### 6. Backup Directory Name Must Match Internal ID

Weaviate backups are directories (not single files). The backup directory name **must match** the internal backup ID in `backup_config.json`. When copying a backup to a new location, `restore.ts` reads `backup_config.json` to discover the real ID and names the target directory accordingly.

### 7. Node Mapping for Cross-Container Restore

When restoring a backup to a container with a different `CLUSTER_HOSTNAME`, the Weaviate restore API requires a `node_mapping` parameter. Without it, restore fails with "cannot resolve hostname" (422).

### 8. Windows Backup Fails (LSM File Locking)

Weaviate on Windows holds exclusive locks on LSM storage files, preventing `fsync` during backup while the server is running. The backup API returns "Access is denied" errors. Integration tests skip the backup/restore clone test on Windows. Same pattern as Meilisearch.

### 9. gRPC Port

The gRPC port is separate from HTTP (HTTP + 1). Ensure both ports are available if using gRPC clients.

### 10. Snapshot Format

Snapshots are Weaviate's native backup format and are not compatible with other databases.

### 11. Health Check Endpoint

Use `/v1/.well-known/ready` for health checks (returns 200 when ready).

### 12. Class/Collection Naming

Weaviate class names must start with an uppercase letter (PascalCase). Container names with dashes are auto-converted (e.g., `my-app` becomes class `My_app`).

## CI/CD Notes

### curl-Based Testing

CI tests use `curl` commands rather than database CLI tools.

### GitHub Actions Cache Step

```yaml
- name: Cache Weaviate binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/weaviate-*
    key: weaviate-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/weaviate/version-maps.ts') }}
```

## REST API Quick Reference

### Schema (Classes)
```bash
# List all classes
GET /v1/schema

# Get class info
GET /v1/schema/{class}

# Create class
POST /v1/schema

# Delete class
DELETE /v1/schema/{class}
```

### Objects
```bash
# Batch insert objects
POST /v1/batch/objects

# Get object
GET /v1/objects/{class}/{id}

# Delete object
DELETE /v1/objects/{class}/{id}
```

### Search
```bash
# GraphQL query
POST /v1/graphql
```

### Meta
```bash
# Server meta info (includes version)
GET /v1/meta

# Health/ready check
GET /v1/.well-known/ready
```
