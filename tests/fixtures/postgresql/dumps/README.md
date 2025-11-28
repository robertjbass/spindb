# PostgreSQL Dump Fixtures

Synthetic PostgreSQL dump files for testing version compatibility detection.

## Files

- `postgresql-14-plain.sql` - Plain SQL dump with PostgreSQL 14 version header
- `postgresql-15-plain.sql` - Plain SQL dump with PostgreSQL 15 version header
- `postgresql-16-plain.sql` - Plain SQL dump with PostgreSQL 16 version header
- `postgresql-17-plain.sql` - Plain SQL dump with PostgreSQL 17 version header

## Purpose

Test the version compatibility logic in `engines/postgresql/version-validator.ts` without needing multiple PostgreSQL versions installed.

## Format

Each file is a minimal pg_dump plain SQL format containing:
- Standard headers including `Dumped from database version X.X`
- A simple test_table with sample rows

## Note

Custom format (.dump) files require `pg_restore -l` to read the version header.
