# InfluxDB Test Fixtures

## Seed Files

InfluxDB 3.x does not support `CREATE TABLE` or `INSERT` via SQL — data writes use line protocol. The `.lp` file is the seed fixture (equivalent to `sample-db.sql` for PostgreSQL).

- **`sample-db.lp`** — Seed fixture. Writes 5 test_user records via line protocol.
- **`sample-queries.sql`** — Verification queries. Run after seeding to confirm data.

### Seeding

```bash
spindb run my-influxdb sample-db.lp --database mydb        # Seed data
spindb run my-influxdb sample-queries.sql --database mydb   # Verify
```

### File Format Reference

| Extension | Endpoint | Purpose |
|-----------|----------|---------|
| `.lp` | `POST /api/v3/write_lp` | Write data (line protocol) |
| `.sql` | `POST /api/v3/query_sql` | Run queries (SELECT, SHOW) |

## Expected Count

Tests expect 5 records after seeding (matching `EXPECTED_COUNTS[influxdb]=5` in `run-e2e.sh`).

## Backup/Restore

- Backup: Queries table schemas and exports data as SQL INSERT statements
- Restore: Converts SQL INSERT statements to line protocol and writes via `POST /api/v3/write_lp`

See `tests/integration/influxdb.test.ts` for backup/restore coverage.
