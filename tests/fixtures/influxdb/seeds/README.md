# InfluxDB Test Fixtures

## Why No Seed File?

Unlike SQL databases that use `.sql` files or Redis/Valkey that use command files,
InfluxDB uses a REST API for all operations. Seed data is written via HTTP
requests to the `/api/v3/write_lp` endpoint (line protocol), while queries use
`/api/v3/query_sql` (SQL).

## How Integration Tests Work

Integration tests seed data directly via the InfluxDB REST API:

1. **Write data**: `POST /api/v3/write_lp?db={database}` with line protocol body
2. **Query data**: `POST /api/v3/query_sql` with SQL query

### Sample Seed Data (inserted via REST API)

Line protocol format:
```
test_user,id=1 name="Alice",email="alice@example.com"
test_user,id=2 name="Bob",email="bob@example.com"
test_user,id=3 name="Charlie",email="charlie@example.com"
test_user,id=4 name="Diana",email="diana@example.com"
test_user,id=5 name="Eve",email="eve@example.com"
```

## Expected Count

Tests expect 5 records after seeding (matching the standard `EXPECTED_COUNTS[influxdb]=5`
in `run-e2e.sh`).

## Backup/Restore

InfluxDB backup uses SQL dump format via the REST API:
- Backup: Queries table schemas and exports data as SQL INSERT statements
- Restore: Converts SQL INSERT statements to line protocol and writes via `POST /api/v3/write_lp`

See integration tests (`tests/integration/influxdb.test.ts`) for backup/restore coverage.
