# MariaDB Dump Fixtures

Synthetic MariaDB dump files for testing version detection.

## Files

- `mariadb-10.11-plain.sql` - MariaDB 10.11 LTS dump (supported until 2028)
- `mariadb-11.4-plain.sql` - MariaDB 11.4 dump (stable)
- `mariadb-11.8-plain.sql` - MariaDB 11.8 dump (latest stable)

## Purpose

Test version detection in MariaDB restore operations.

## Format

MariaDB dumps include version info in the header:
```sql
-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB, for debian-linux-gnu (x86_64)
-- Server version	10.11.6-MariaDB-1
```

## MySQL vs MariaDB

MySQL and MariaDB are **separate engines** in SpinDB. They forked in 2010 and have diverged:

| MySQL | MariaDB | Notes |
|-------|---------|-------|
| 5.5   | 5.5     | Last compatible versions |
| 5.6   | 10.0    | MariaDB jumped to 10.x |
| 5.7   | 10.1-10.2 | Feature parity, not version parity |
| 8.0   | 10.3-10.11 | Significantly diverged |
| 9.0   | 11.x    | Different features entirely |

## Compatibility Notes

- MariaDB dumps may use MariaDB-specific features not available in MySQL
- SpinDB treats MySQL and MariaDB as separate engines

## See Also

- `tests/fixtures/mysql/dumps/` - MySQL dump fixtures (separate engine)
