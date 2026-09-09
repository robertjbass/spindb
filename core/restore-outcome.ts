import { parsePgRestoreDiagnostics } from '../engines/postgresql/restore-diagnostics'
import type { PgRestoreDiagnostics, RestoreResult } from '../types'

export type RestoreOutcome = {
  /** The restore did not run, or ran and produced nothing usable. Throw. */
  failed: boolean
  /** The restore ran and some objects could not be created. */
  hadObjectErrors: boolean
  /** What `--json` reports. */
  status: 'completed' | 'completed_with_errors'
  diagnostics: PgRestoreDiagnostics
  /** One line for a spinner: what actually happened. */
  summary: string
}

/**
 * Decide what a `RestoreResult` means.
 *
 * The rule this replaces was "fail only when stderr contains the literal
 * FATAL", which is why a Supabase migration that lost 19 tables (missing
 * `uuid-ossp`, so every `CREATE TABLE` with a `uuid_generate_v4()` default
 * failed, so every `COPY` was skipped) printed `success: true` and exited 0.
 *
 * Three outcomes, in order:
 * 1. `FATAL` in stderr, or a non-zero exit with nothing to explain it -> the
 *    restore failed. The caller throws and its rollback runs.
 * 2. Object-level errors (parsed, or a `errors ignored on restore: N` summary)
 *    -> completed_with_errors. Still a success for exit-code purposes (data
 *    DID land, and a rollback here would throw away a usable partial restore),
 *    but it says so, in `--json` too.
 * 3. Otherwise -> completed.
 *
 * A `partial` result (an engine that restored some of its data and then hit
 * errors it reported itself) is never classified as an unexplained failure:
 * rolling that back would drop a database that holds most of the data.
 */
export function classifyRestoreOutcome(result: RestoreResult): RestoreOutcome {
  const stderr = result.stderr || ''
  let diagnostics = result.diagnostics ?? parsePgRestoreDiagnostics(stderr, 200)

  // An engine that reported a partial restore in its own words (InfluxDB
  // writes table by table) still owes the caller the list. Its lines do not
  // look like pg_restore's, so take them as-is rather than dropping them.
  if (result.partial && diagnostics.restoreErrorCount === 0) {
    const lines = [...new Set(stderr.split('\n').map((l) => l.trim()))].filter(
      Boolean,
    )
    if (lines.length > 0) {
      diagnostics = {
        ...diagnostics,
        restoreErrors: lines.slice(0, 200),
        restoreErrorCount: lines.length,
        truncated: diagnostics.truncated || lines.length > 200,
      }
    }
  }

  const hadObjectErrors =
    diagnostics.restoreErrorCount > 0 ||
    (diagnostics.restoreIgnoredErrors ?? 0) > 0

  const isFatal = stderr.includes('FATAL')
  const unexplainedFailure =
    result.code !== undefined &&
    result.code !== 0 &&
    !hadObjectErrors &&
    !result.partial

  if (isFatal || unexplainedFailure) {
    return {
      failed: true,
      hadObjectErrors,
      status: 'completed_with_errors',
      diagnostics,
      summary: 'Restore failed',
    }
  }

  if (hadObjectErrors || result.partial) {
    const count =
      diagnostics.restoreIgnoredErrors ?? diagnostics.restoreErrorCount
    return {
      failed: false,
      hadObjectErrors: true,
      status: 'completed_with_errors',
      diagnostics,
      summary: count
        ? `Restore completed with ${count} object error(s)`
        : 'Restore completed with errors',
    }
  }

  return {
    failed: false,
    hadObjectErrors: false,
    status: 'completed',
    diagnostics,
    summary: 'Backup restored successfully',
  }
}

/**
 * The message a failed restore throws. Prefers the tool's own stderr, since it
 * names the object that could not be created.
 */
export function restoreFailureMessage(result: RestoreResult): string {
  return result.stderr?.trim() || result.stdout?.trim() || 'Restore failed'
}

/**
 * The lines a human should see after a restore that hit object errors. Errors
 * first (they are what lost data), then warnings, capped.
 */
export function restoreErrorReportLines(
  diagnostics: PgRestoreDiagnostics,
  limit = 10,
): string[] {
  const lines = [...diagnostics.restoreErrors, ...diagnostics.restoreWarnings]
  if (lines.length <= limit) return lines
  return [
    ...lines.slice(0, limit),
    `... and ${lines.length - limit} more (re-run without --json to see the tool's full output)`,
  ]
}

/**
 * The `--json` fields that describe a partial restore. Empty for a clean one,
 * so the shape only grows when something actually went wrong.
 */
export function restoreDiagnosticsJson(
  outcome: RestoreOutcome,
): Record<string, unknown> {
  if (!outcome.hadObjectErrors) return {}
  const d = outcome.diagnostics
  return {
    restoreErrorCount: d.restoreErrorCount,
    restoreErrors: d.restoreErrors,
    restoreWarningCount: d.restoreWarningCount,
    restoreIgnoredErrors: d.restoreIgnoredErrors,
    restoreErrorsTruncated: d.truncated,
  }
}
