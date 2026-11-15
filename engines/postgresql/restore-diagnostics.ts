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
 * psql echoes the filename exactly as it received it, so on Windows the path
 * carries a drive letter and its own colon
 * (`psql:C:\Users\me\dump.sql:214: ERROR:  ...`). The path segment therefore
 * has to be allowed to contain colons: stopping at the first one made every
 * Windows psql error invisible, so a partial restore reported a clean success
 * there while reporting the truth everywhere else.
 * A bare `ERROR:` covers a server message psql echoed without its own prefix.
 */
const PSQL_ERROR = /^psql:.+:\d+:\s*ERROR:/
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
  let pendingError: string | null = null

  function flushError() {
    if (pendingError === null) return
    if (errors.size < cap) errors.add(pendingError)
    else if (!errors.has(pendingError)) errorsDropped = true
    pendingError = null
  }

  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!line) continue

    const summary = line.match(IGNORED_ERRORS_SUMMARY)
    if (summary) {
      flushError()
      restoreIgnoredErrors = Number(summary[1])
      continue
    }

    if (
      PG_RESTORE_ERROR.test(line) ||
      PSQL_ERROR.test(line) ||
      BARE_ERROR.test(line)
    ) {
      restoreErrorCount++
      flushError()
      pendingError = line
      continue
    }

    // Retain only the identifier, never column defaults, literals or COPY data.
    const table =
      /^Command was: CREATE (?:UNLOGGED )?TABLE ((?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)\.(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*))\s*\(/.exec(
        line,
      )
    if (pendingError && table) {
      pendingError += ` [failed CREATE TABLE ${table[1]}]`
      flushError()
    }
    if (line.startsWith('pg_restore:') && !PG_RESTORE_ERROR.test(line))
      flushError()

    if (PG_RESTORE_WARNING.test(line)) {
      restoreWarningCount++
      if (warnings.size < cap) {
        warnings.add(line)
      } else if (!warnings.has(line)) {
        warningsDropped = true
      }
    }
  }

  flushError()
  return {
    restoreErrors: [...errors],
    restoreErrorCount,
    restoreWarnings: [...warnings],
    restoreWarningCount,
    restoreIgnoredErrors,
    truncated: errorsDropped || warningsDropped,
  }
}
