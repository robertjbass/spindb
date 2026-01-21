# Qdrant Test Fixtures

## Why No Seed File?

Unlike SQL databases that use `.sql` files or Redis/Valkey that use command files,
Qdrant uses a REST API for all operations. This means seed data is inserted via
HTTP requests rather than CLI commands.

## Snapshot Files

Qdrant snapshots are not stored in git because they are too large according to
best practices. Even a collection with just 3 points creates a ~334MB snapshot
file due to Qdrant's internal storage structure (pre-allocated segments, indices,
and WAL files).

**To generate a snapshot on demand:**

```bash
pnpm generate:qdrant-snapshot              # Creates test_vectors.snapshot
pnpm generate:qdrant-snapshot my-backup    # Creates my-backup.snapshot
```

This script will:
1. Connect to a running Qdrant container
2. Create a test collection with sample data (3 points)
3. Generate a snapshot file
4. Save it to the appropriate location:
   - If run from the spindb project: `tests/fixtures/qdrant/snapshots/test_vectors.snapshot`
   - If run elsewhere: `./test_vectors.snapshot` in the current directory

## How Docker E2E Tests Work

The Docker E2E test script (`tests/docker/run-e2e.sh`) seeds Qdrant data directly
via `curl` commands to the REST API instead of using fixture files:

1. **Create Collection**: `PUT /collections/test_vectors`
2. **Insert Points**: `PUT /collections/test_vectors/points`

### Sample Seed Data (inserted via REST API)

```json
{
  "collection": "test_vectors",
  "vectors": {
    "size": 4,
    "distance": "Cosine"
  },
  "points": [
    {"id": 1, "vector": [0.1, 0.2, 0.3, 0.4], "payload": {"name": "Alice", "city": "NYC"}},
    {"id": 2, "vector": [0.2, 0.3, 0.4, 0.5], "payload": {"name": "Bob", "city": "LA"}},
    {"id": 3, "vector": [0.9, 0.8, 0.7, 0.6], "payload": {"name": "Charlie", "city": "SF"}}
  ]
}
```

## Expected Count

The `EXPECTED_COUNTS[qdrant]=3` in `run-e2e.sh` expects 3 points after seeding.

## Backup/Restore

Qdrant backup/restore uses snapshot-based operations via REST API:
- Create snapshot: `POST /collections/{name}/snapshots`
- List snapshots: `GET /collections/{name}/snapshots`
- Recover from snapshot: `PUT /collections/{name}/snapshots/upload`

See integration tests (`tests/integration/qdrant.test.ts`) for backup/restore coverage.
