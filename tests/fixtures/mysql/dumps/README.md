# MySQL Dump Fixtures

Synthetic MySQL dump files for testing version detection.

## Files

- `mysql-8.0-plain.sql` - MySQL 8.0 dump (LTS, utf8mb4 charset)
- `mysql-8.4-plain.sql` - MySQL 8.4 dump (innovation release, utf8mb4 charset)
- `mysql-9-plain.sql` - MySQL 9 dump (latest stable, utf8mb4 charset)

## Purpose

Test version detection in MySQL restore operations.

## Format

MySQL dumps include version info in the header:
```sql
-- MySQL dump 10.13  Distrib 8.0.36, for macos14.2 (arm64)
-- Server version	8.0.36
```

## Compatibility Notes

- MySQL 8.x/9.x dumps are generally forward compatible
- The `mysql` client is more forgiving than `pg_restore` for version mismatches

## Key Differences Between 8.0 and 8.4/9

- **8.0**: LTS release with long-term support
- **8.4**: Innovation release with newer features
- **9.0**: Latest major version

## See Also

- `tests/fixtures/mariadb/dumps/` - MariaDB dump fixtures (separate engine)
