# Weaviate Test Fixtures

## Why No Seed File?

Unlike SQL databases that use `.sql` files or Redis/Valkey that use command files,
Weaviate uses a REST API for all operations. This means seed data is inserted via
HTTP requests rather than CLI commands.

## Snapshot Files

Weaviate snapshots are not stored in git because they are too large according to
best practices. Weaviate's filesystem backup format includes pre-allocated storage
segments and indices.

**To generate a snapshot on demand:**

```bash
pnpm generate:backup weaviate              # Creates backup snapshot
pnpm generate:backup weaviate my-backup    # Creates named snapshot
```

## How Docker E2E Tests Work

The Docker E2E test script (`tests/docker/run-e2e.sh`) seeds Weaviate data directly
via `curl` commands to the REST API instead of using fixture files:

1. **Create Class**: `POST /v1/schema`
2. **Insert Objects**: `POST /v1/batch/objects`

### Sample Seed Data (inserted via REST API)

```json
{
  "class": "TestVectors",
  "vectorizer": "none",
  "properties": [
    {"name": "name", "dataType": ["text"]},
    {"name": "city", "dataType": ["text"]}
  ],
  "objects": [
    {"properties": {"name": "Alice", "city": "NYC"}, "vector": [0.1, 0.2, 0.3, 0.4]},
    {"properties": {"name": "Bob", "city": "LA"}, "vector": [0.2, 0.3, 0.4, 0.5]},
    {"properties": {"name": "Charlie", "city": "SF"}, "vector": [0.9, 0.8, 0.7, 0.6]}
  ]
}
```

## Expected Count

The `EXPECTED_COUNTS[weaviate]=3` in `run-e2e.sh` expects 3 objects after seeding.

## Backup/Restore

Weaviate backup/restore uses filesystem-based operations via REST API:
- Create backup: `POST /v1/backups/filesystem`
- Check status: `GET /v1/backups/filesystem/{id}`
- Restore backup: `POST /v1/backups/filesystem/{id}/restore`

See integration tests (`tests/integration/weaviate.test.ts`) for backup/restore coverage.
