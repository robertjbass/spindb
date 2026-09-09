import type { PgRestoreDiagnostics } from '../../types'

/**
 * The final summary `pg_restore` prints when it kept going past failures:
 * `pg_restore: warning: errors ignored on restore: 819`. It is the one line
 * that says the restore RAN and was incomplete, so it is read for its count
 * and kept out of the warnings list.
 */
const IGNORED_ERRORS_SUMMARY =
  /^pg_restore:\s+warning:\s+errors ignored on restore:\s+(\d+)\s*$/

/** `pg_restore: error: could not execute query: ERROR:  ...` */
const PG_RESTORE_ERROR = /^pg_restore:\s+error:\s+(.*)$/

/** `pg_restore: warning: ...` (anything but the summary above). */
const PG_RESTORE_WARNING = /^pg_restore:\s+warning:\s+/

/**
 * The plain-SQL restore branch runs `psql -f`, which reports failures as
 * `psql:/tmp/dump.sql:214: ERROR:  relation "public.staff" does not exist`.
 * A bare `ERROR:` covers a server message psql echoed without its own prefix.
 */
const PSQL_ERROR = /^psql:[^:]*:\d+:\s*ERROR:/
const BARE_ERROR = /^ERROR:/

/**
 * Read the object-level failures out of a PostgreSQL restore's stderr.
 *
 * Pure and total: any string is valid input, and an empty or unrecognized
 * stderr yields zero counts rather than throwing. The caller decides what a
 * non-zero count MEANS (see `core/restore-outcome.ts`); this only reports what
 * the tool said.
 *
 * @param stderr - Raw stderr from `pg_restore` or `psql`.
 * @param cap - Maximum lines kept in each array (the counts are uncapped).
 */
export function parsePgRestoreDiagnostics(
  stderr: string,
  cap = 200,
): PgRestoreDiagnostics {
  const errors = new Set<string>()
  const warnings = new Set<string>()
  let restoreErrorCount = 0
  let restoreWarningCount = 0
  let restoreIgnoredErrors: number | null = null
  let errorsDropped = false
  let warningsDropped = false

  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!line) continue

    const summary = line.match(IGNORED_ERRORS_SUMMARY)
    if (summary) {
      restoreIgnoredErrors = Number(summary[1])
      continue
    }

    if (
      PG_RESTORE_ERROR.test(line) ||
      PSQL_ERROR.test(line) ||
      BARE_ERROR.test(line)
    ) {
      restoreErrorCount++
      if (errors.size < cap) {
        errors.add(line)
      } else if (!errors.has(line)) {
        errorsDropped = true
      }
      continue
    }

    if (PG_RESTORE_WARNING.test(line)) {
      restoreWarningCount++
      if (warnings.size < cap) {
        warnings.add(line)
      } else if (!warnings.has(line)) {
        warningsDropped = true
      }
    }
  }

  return {
    restoreErrors: [...errors],
    restoreErrorCount,
    restoreWarnings: [...warnings],
    restoreWarningCount,
    restoreIgnoredErrors,
    truncated: errorsDropped || warningsDropped,
  }
}
