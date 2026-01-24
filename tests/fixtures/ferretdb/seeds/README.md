# FerretDB Test Fixtures

FerretDB is a MongoDB-compatible proxy that stores data in PostgreSQL.

## Authentication

SpinDB runs FerretDB with `--no-auth` for local development, similar to how
PostgreSQL uses trust authentication and MySQL uses `--skip-grant-tables`.
No credentials are required to connect.

## Seed Data

The `sample-db.js` file contains test data that can be run with mongosh:

```bash
mongosh mongodb://localhost:27017/testdb --file sample-db.js
```

This creates:
- `test_user` collection with 5 user documents

## Testing Approach

FerretDB uses MongoDB client tools (mongosh, mongodump, mongorestore) for
interaction. Since backups use pg_dump/pg_restore on the PostgreSQL backend,
testing follows the same patterns as PostgreSQL with MongoDB-compatible
connection strings.

## Docker E2E Tests

For Docker E2E tests, use mongosh (when available) or curl against the
MongoDB wire protocol (FerretDB listens on port 27017 by default).

```bash
mongosh mongodb://localhost:27017/test
```
