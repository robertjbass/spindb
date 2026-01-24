# FerretDB Test Fixtures

FerretDB is a MongoDB-compatible proxy that stores data in PostgreSQL.

## Seed Data

The `sample-db.js` file contains test data that can be run with mongosh:

```bash
mongosh mongodb://localhost:27017/test --file sample-db.js
```

This creates:
- `test_users` collection with 5 user documents
- `test_products` collection with 3 product documents

## Testing Approach

FerretDB uses MongoDB client tools (mongosh, mongodump, mongorestore) for
interaction. Since backups use pg_dump/pg_restore on the PostgreSQL backend,
testing follows the same patterns as PostgreSQL with MongoDB-compatible
connection strings.

## Docker E2E Tests

For Docker E2E tests, use mongosh (when available) or curl against the
MongoDB wire protocol (FerretDB listens on port 27017 by default).
