/**
 * Restore diagnostics: what pg_restore said, and what it means.
 *
 * The fixture is the shape of the real failure this exists for: a Supabase
 * dump restored into a plain PostgreSQL, where `uuid-ossp` is unavailable, so
 * every CREATE TABLE with a `uuid_generate_v4()` default failed, so every COPY
 * into those tables was skipped, and 19 tables silently did not arrive.
 */

import { describe, it } from 'node:test'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { assert, assertEqual } from '../utils/assertions'
import { parsePgRestoreDiagnostics } from '../../engines/postgresql/restore-diagnostics'
import {
  classifyRestoreOutcome,
  restoreDiagnosticsJson,
  restoreErrorReportLines,
  restoreFailureMessage,
} from '../../core/restore-outcome'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FIXTURE = readFileSync(
  join(__dirname, '../fixtures/postgresql/stderr/supabase-partial.txt'),
  'utf8',
)

describe('parsePgRestoreDiagnostics', () => {
  it('counts every pg_restore error line and dedupes the list', () => {
    const d = parsePgRestoreDiagnostics(FIXTURE)

    assertEqual(d.restoreErrorCount, 9, 'every error line is counted')
    assertEqual(
      d.restoreErrors.length,
      6,
      'repeated lines collapse to one entry',
    )
    assert(
      d.restoreErrors.some((l) => l.includes('extension "uuid-ossp"')),
      'the missing extension is reported',
    )
    assert(
      d.restoreErrors.some((l) =>
        l.includes('function extensions.uuid_generate_v4() does not exist'),
      ),
      'the failed column default is reported',
    )
    assert(
      d.restoreErrors.some((l) =>
        l.includes('relation "public.staff" does not exist'),
      ),
      'the skipped COPY is reported',
    )
    assert(
      d.restoreErrors.some((l) => l.includes('role "authenticated"')),
      'the missing role is reported',
    )
  })

  it('reads the ignored-errors summary and keeps it out of the warnings', () => {
    const d = parsePgRestoreDiagnostics(FIXTURE)

    assertEqual(d.restoreIgnoredErrors, 819, 'the summary count is read')
    assertEqual(d.restoreWarningCount, 1, 'only the real warning is counted')
    assert(
      !d.restoreWarnings.some((l) => l.includes('errors ignored on restore')),
      'the summary is not itself a warning',
    )
  })

  it('reports psql ERROR lines from the plain-SQL restore branch', () => {
    const stderr = [
      'psql:/tmp/spindb-dump.sql:214: ERROR:  relation "public.staff" does not exist',
      'psql:/tmp/spindb-dump.sql:215: NOTICE:  table "x" does not exist, skipping',
      'ERROR:  role "authenticated" does not exist',
    ].join('\n')

    const d = parsePgRestoreDiagnostics(stderr)
    assertEqual(d.restoreErrorCount, 2, 'ERROR lines count, NOTICE does not')
    assertEqual(d.restoreErrors.length, 2, 'both are distinct')
  })

  it('reports psql ERROR lines when the dump path carries a drive letter', () => {
    // What psql prints on Windows: the filename is echoed as given, so the
    // path holds its own colon and CRLF ends every line. Both used to hide
    // the errors, which made a partial restore look clean on Windows only.
    const stderr = [
      'psql:C:\\Users\\runneradmin\\AppData\\Local\\Temp\\pg-partial.sql:1: ERROR:  extension "does_not_exist_ext" is not available',
      'psql:C:\\Users\\runneradmin\\AppData\\Local\\Temp\\pg-partial.sql:2: ERROR:  function shim_label() does not exist',
      'psql:C:/Users/runneradmin/AppData/Local/Temp/pg-partial.sql:3: NOTICE:  table "x" does not exist, skipping',
    ].join('\r\n')

    const d = parsePgRestoreDiagnostics(stderr)
    assertEqual(
      d.restoreErrorCount,
      2,
      'both ERROR lines count, NOTICE does not',
    )
    assert(
      d.restoreErrors.some((l) => l.includes('does_not_exist_ext')),
      'the failing object is named',
    )

    const outcome = classifyRestoreOutcome({
      format: 'sql',
      stderr,
      code: 0,
    })
    assertEqual(
      outcome.status,
      'completed_with_errors',
      'a partial Windows restore is not a clean success',
    )
  })

  it('is empty for a clean restore and for empty input', () => {
    const clean = parsePgRestoreDiagnostics('')
    assertEqual(clean.restoreErrorCount, 0, 'no errors')
    assertEqual(clean.restoreWarningCount, 0, 'no warnings')
    assertEqual(clean.restoreIgnoredErrors, null, 'no summary')
    assertEqual(clean.truncated, false, 'nothing dropped')

    const chatter = parsePgRestoreDiagnostics(
      ['pg_restore: connecting to database for restore', ''].join('\n'),
    )
    assertEqual(chatter.restoreErrorCount, 0, 'progress lines are not errors')
  })

  it('caps the arrays without capping the counts', () => {
    const stderr = Array.from(
      { length: 30 },
      (_, i) => `pg_restore: error: could not execute query: ERROR:  bad ${i}`,
    ).join('\n')

    const d = parsePgRestoreDiagnostics(stderr, 10)
    assertEqual(d.restoreErrorCount, 30, 'the count is the real total')
    assertEqual(d.restoreErrors.length, 10, 'the list is capped')
    assertEqual(d.truncated, true, 'and says so')
  })

  it('tolerates CRLF and leading whitespace', () => {
    const d = parsePgRestoreDiagnostics(
      '  pg_restore: error: could not execute query: ERROR:  boom\r\npg_restore: warning: errors ignored on restore: 1\r\n',
    )
    assertEqual(d.restoreErrorCount, 1, 'the error is found')
    assertEqual(d.restoreIgnoredErrors, 1, 'the summary is found')
  })
})

describe('classifyRestoreOutcome', () => {
  it('reports a partial restore instead of a clean success', () => {
    const outcome = classifyRestoreOutcome({
      format: 'custom',
      stderr: FIXTURE,
      code: 1,
    })

    assertEqual(outcome.failed, false, 'a partial restore is not a failure')
    assertEqual(outcome.hadObjectErrors, true, 'object errors are reported')
    assertEqual(outcome.status, 'completed_with_errors', 'status says so')
    assert(
      outcome.summary.includes('819'),
      'the summary names the error count the tool reported',
    )
  })

  it('calls a clean restore completed', () => {
    const outcome = classifyRestoreOutcome({
      format: 'custom',
      stderr: '',
      code: 0,
    })
    assertEqual(outcome.status, 'completed', 'nothing went wrong')
    assertEqual(outcome.hadObjectErrors, false, 'no object errors')
    assertEqual(outcome.failed, false, 'not a failure')
  })

  it('fails on a non-zero exit it cannot explain', () => {
    const outcome = classifyRestoreOutcome({
      format: 'custom',
      stderr: 'connection to server at "127.0.0.1", port 5432 failed',
      code: 1,
    })
    assertEqual(outcome.failed, true, 'an unexplained failure is a failure')
  })

  it('fails on FATAL even when objects also failed', () => {
    const outcome = classifyRestoreOutcome({
      format: 'custom',
      stderr: `${FIXTURE}\nFATAL: terminating connection due to administrator command`,
      code: 1,
    })
    assertEqual(outcome.failed, true, 'FATAL still fails')
  })

  it('never fails a code-less result (the old undefined-code bug)', () => {
    // engines/postgresql/restore.ts used to spread {stdout, stderr} and leave
    // `code` undefined on success, which read as "not zero" everywhere.
    const outcome = classifyRestoreOutcome({ format: 'sql', stderr: '' })
    assertEqual(outcome.failed, false, 'no code means no verdict from the code')
    assertEqual(outcome.status, 'completed', 'and it is a clean restore')
  })

  it('treats an engine-reported partial result as partial, not as a failure', () => {
    const outcome = classifyRestoreOutcome({
      format: 'sql',
      stdout: 'Restored 900 records from 10 tables. 1 errors.',
      stderr: 'Failed to write cpu: {"error":"schema conflict"}',
      code: 1,
      partial: true,
    })
    assertEqual(outcome.failed, false, 'a partial write is not a total failure')
    assertEqual(outcome.status, 'completed_with_errors', 'reported as partial')
    assertEqual(
      outcome.diagnostics.restoreErrorCount,
      1,
      "the engine's own error line is carried through",
    )
  })

  it('exposes only the fields a partial restore needs in --json', () => {
    const clean = classifyRestoreOutcome({ format: 'custom', code: 0 })
    assertEqual(
      Object.keys(restoreDiagnosticsJson(clean)).length,
      0,
      'a clean restore adds no fields',
    )

    const partial = classifyRestoreOutcome({
      format: 'custom',
      stderr: FIXTURE,
      code: 1,
    })
    const json = restoreDiagnosticsJson(partial) as Record<string, unknown>
    assertEqual(json.restoreErrorCount, 9, 'error count is reported')
    assertEqual(json.restoreIgnoredErrors, 819, 'ignored count is reported')
    assertEqual(json.restoreWarningCount, 1, 'warning count is reported')
    assertEqual(json.restoreErrorsTruncated, false, 'nothing was dropped')
    assert(Array.isArray(json.restoreErrors), 'the error lines are included')
  })

  it('reports the tool stderr as the failure message', () => {
    assertEqual(
      restoreFailureMessage({ format: 'custom', stderr: '  boom  ', code: 1 }),
      'boom',
      'stderr wins',
    )
    assertEqual(
      restoreFailureMessage({ format: 'custom', code: 1 }),
      'Restore failed',
      'never an empty message',
    )
  })

  it('caps the human report and says how much it dropped', () => {
    const d = parsePgRestoreDiagnostics(FIXTURE)
    const lines = restoreErrorReportLines(d, 3)
    assertEqual(lines.length, 4, 'three lines plus the tail')
    assert(lines[3].includes('more'), 'the tail says there is more')
  })
})
