# CouchDB Test Seeds

CouchDB is a REST API-based document database. Unlike SQL databases that use `.sql` seed files, CouchDB operations are performed via HTTP REST API calls.

## Why No Seed Files?

CouchDB doesn't have a traditional CLI tool for executing seed scripts. All operations are performed through the HTTP REST API using tools like `curl`.

## Test Data Operations

### Creating a Database

```bash
curl -X PUT http://127.0.0.1:5984/test_db
```

### Inserting Documents

```bash
# Insert a single document
curl -X POST http://127.0.0.1:5984/test_db \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "age": 30}'

# Bulk insert documents
curl -X POST http://127.0.0.1:5984/test_db/_bulk_docs \
  -H "Content-Type: application/json" \
  -d '{
    "docs": [
      {"_id": "user1", "name": "Bob", "age": 25},
      {"_id": "user2", "name": "Charlie", "age": 35},
      {"_id": "user3", "name": "Diana", "age": 28},
      {"_id": "user4", "name": "Eve", "age": 32},
      {"_id": "user5", "name": "Frank", "age": 40}
    ]
  }'
```

### Retrieving Documents

```bash
# Get all documents
curl http://127.0.0.1:5984/test_db/_all_docs?include_docs=true

# Get a specific document
curl http://127.0.0.1:5984/test_db/user1
```

### Health Check

```bash
curl http://127.0.0.1:5984
```

## Integration Test Approach

Integration tests for CouchDB use the Node.js `fetch` API to:
1. Create databases
2. Insert test documents via `_bulk_docs`
3. Query documents via `_all_docs`
4. Verify backup/restore operations
5. Clean up test data

See `tests/integration/couchdb.test.ts` for the full implementation.
