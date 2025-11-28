# MySQL/MariaDB Dump Fixtures

Synthetic MySQL and MariaDB dump files for testing version detection.

## Files

### MySQL
- `mysql-5.7-plain.sql` - MySQL 5.7 dump (legacy LTS, EOL Dec 2023, utf8 charset)
- `mysql-8.0-plain.sql` - MySQL 8.0 dump (current LTS, utf8mb4 charset)
- `mysql-9.0-plain.sql` - MySQL 9.0 dump (latest stable, utf8mb4 charset)

### MariaDB
- `mariadb-10.11-plain.sql` - MariaDB 10.11 LTS dump (supported until 2028)
- `mariadb-11.4-plain.sql` - MariaDB 11.4 dump (latest stable)

## Purpose

Test version detection in MySQL restore operations. Unlike PostgreSQL, MySQL/MariaDB has broader cross-version compatibility, but the dump format differs between MySQL and MariaDB.

## MySQL vs MariaDB

MySQL and MariaDB are **NOT version-equivalent**. They forked in 2010 and have diverged significantly:

| MySQL | MariaDB | Notes |
|-------|---------|-------|
| 5.5   | 5.5     | Last compatible versions |
| 5.6   | 10.0    | MariaDB jumped to 10.x |
| 5.7   | 10.1-10.2 | Feature parity, not version parity |
| 8.0   | 10.3-10.11 | Significantly diverged |
| 9.0   | 11.x    | Different features entirely |

SpinDB treats them as separate products and warns when cross-restoring.

## Format

MySQL dumps include version info in the header:
```sql
-- MySQL dump 10.13  Distrib 8.0.36, for macos14.2 (arm64)
-- Server version	8.0.36
```

MariaDB dumps use a similar but distinct format:
```sql
-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB, for debian-linux-gnu (x86_64)
-- Server version	10.11.6-MariaDB-1
```

## Compatibility Notes

- MySQL 8.x dumps may fail on MySQL 5.7 clients due to new syntax/features
- MySQL 5.7 dumps generally restore to MySQL 8.x (backwards compatible)
- MariaDB dumps may use MariaDB-specific features not available in MySQL
- The `mysql` client is more forgiving than `pg_restore` for version mismatches

## Key Differences Between 5.7 and 8.0

- **Charset**: 5.7 uses `utf8` (3-byte), 8.0 uses `utf8mb4` (4-byte)
- **Collation**: 5.7 uses `utf8_general_ci`, 8.0 uses `utf8mb4_0900_ai_ci`
- **INT display width**: 5.7 uses `int(11)`, 8.0 dropped display width
- **Authentication**: 8.0 defaults to `caching_sha2_password` vs 5.7's `mysql_native_password`
