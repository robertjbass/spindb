# Meilisearch Test Fixtures

Meilisearch is a REST API-based search engine. Unlike SQL databases, it doesn't use SQL files for seeding data. Instead, test data is inserted via the REST API during test execution.

## API-Based Seeding Approach

The integration tests create indexes and insert documents programmatically using:

1. `POST /indexes` - Create an index
2. `POST /indexes/{uid}/documents` - Insert documents

## Test Data Structure

The integration tests use the following test data:

```json
[
  { "id": 1, "title": "Hello World", "content": "This is the first document" },
  { "id": 2, "title": "Second Post", "content": "This is another document" },
  { "id": 3, "title": "Third Entry", "content": "Yet another test document" }
]
```

## Helper Functions

See `tests/integration/helpers.ts` for Meilisearch-specific helper functions:

- `getMeilisearchIndexCount(port)` - Get count of indexes
- `createMeilisearchIndex(port, uid, primaryKey)` - Create an index
- `insertMeilisearchDocuments(port, indexUid, documents)` - Insert documents
- `getMeilisearchDocumentCount(port, indexUid)` - Get document count in an index
- `waitForMeilisearchTask(port, taskUid)` - Wait for async task completion
- `deleteMeilisearchIndex(port, uid)` - Delete an index

## Note on Snapshots

Meilisearch backups use snapshots created via `POST /snapshots`. These are binary files that contain the full database state and are restored by placing them in the data directory and starting the server.
