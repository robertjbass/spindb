/**
 * MariaDB -> MySQL Dump Normalization
 *
 * A dump taken from a MariaDB source with `mariadb-dump` is valid SQL for
 * MariaDB, not for MySQL. Three things in it stop a MySQL 8 or 9 target, and
 * all three are mechanical rewrites of statements MySQL has an exact or a
 * near-exact equivalent for:
 *
 * 1. **uca1400 collations.** MariaDB 11.4 made `utf8mb4_uca1400_ai_ci` the
 *    default database collation, so nearly every `CREATE TABLE` in a modern
 *    MariaDB dump names a collation MySQL has never had. MySQL's UCA 9.0.0
 *    collations are the same Unicode collation algorithm at a newer UCA
 *    version, so `utf8mb4_0900_ai_ci` is the honest counterpart.
 * 2. **`NO_AUTO_CREATE_USER` in `SET sql_mode`.** MariaDB still emits it around
 *    triggers and routines; MySQL removed the mode in 8.0 and answers
 *    ERROR 1231 (Variable 'sql_mode' can't be set to the value of
 *    'NO_AUTO_CREATE_USER').
 * 3. **The sandbox directive.** `mariadb-dump` 11.x opens every dump with
 *    `/*M!999999\- enable the sandbox mode *\/`. MySQL reads it as a comment
 *    and is unharmed, but it is MariaDB-only noise in a file we are converting.
 *
 * What is deliberately NOT rewritten: sequences (`CREATE SEQUENCE`, `nextval()`
 * defaults) and MariaDB-only column types (`UUID`, `INET4`, `INET6`,
 * `VECTOR`). MySQL has no equivalent, and quietly substituting one would put
 * different data in the target than the source holds. Those statements are left
 * to fail with the server's own error, which names the object that could not be
 * converted. `json_valid()` CHECK constraints need no rewrite: MySQL has
 * `json_valid()`.
 *
 * Every rule is line-oriented, so a multi-gigabyte dump is rewritten as a
 * stream and never held in memory. The rules are applied through a small
 * statement-aware wrapper (`createMariaDbDumpNormalizer`) rather than to each
 * line in isolation, because `mariadb-dump` writes an extended insert across
 * many lines and only the first of them starts with the `INSERT` keyword the
 * row guard matches on.
 */

import { createReadStream, createWriteStream } from 'fs'
import { createInterface } from 'readline'
import { once } from 'events'

/**
 * How many times each rule fired. Reported to the user and included in
 * `--json`, because a silent rewrite of someone's schema is not acceptable.
 */
export type DumpNormalizationCounts = {
  collationsMapped: number
  sqlModeFlagsRemoved: number
  sandboxDirectivesDropped: number
}

export type NormalizedDumpLine = {
  /** The rewritten line, or null when the line is dropped entirely. */
  line: string | null
  counts: DumpNormalizationCounts
}

export function emptyNormalizationCounts(): DumpNormalizationCounts {
  return {
    collationsMapped: 0,
    sqlModeFlagsRemoved: 0,
    sandboxDirectivesDropped: 0,
  }
}

export function totalRewrites(counts: DumpNormalizationCounts): number {
  return (
    counts.collationsMapped +
    counts.sqlModeFlagsRemoved +
    counts.sandboxDirectivesDropped
  )
}

// MySQL's UCA 9.0.0 counterparts, keyed by MariaDB's accent/case suffix.
// MySQL has no accent-insensitive-but-case-sensitive utf8mb4 collation, so
// `ai_cs` maps to `as_cs`: the case sensitivity the schema asked for is kept,
// and accent sensitivity is the property that cannot be honored.
const UCA1400_SUFFIX_MAP: Record<string, string> = {
  ai_ci: 'utf8mb4_0900_ai_ci',
  as_cs: 'utf8mb4_0900_as_cs',
  as_ci: 'utf8mb4_0900_as_ci',
  ai_cs: 'utf8mb4_0900_as_cs',
}

// The two suffixes that ask for case sensitivity. MariaDB spells accent and
// case sensitivity separately; only the case half survives a utf8mb3 target.
const CASE_SENSITIVE_SUFFIXES = new Set(['as_cs', 'ai_cs'])

const UTF8MB4_FALLBACK = 'utf8mb4_0900_ai_ci'
const UTF8MB3_FALLBACK = 'utf8mb3_unicode_ci'
// MySQL has no utf8mb3 UCA collation that is case sensitive, so a schema that
// asked for one gets `utf8mb3_bin`. Binary ordering is not UCA ordering, but it
// is the only utf8mb3 collation that keeps case sensitivity, and losing case
// sensitivity silently changes which rows a comparison matches.
const UTF8MB3_CASE_SENSITIVE = 'utf8mb3_bin'

const UTF8MB4_UCA1400 = /\butf8mb4_uca1400_([a-z0-9_]+)/gi
const UTF8MB3_UCA1400 = /\b(?:utf8mb3|utf8)_uca1400_([a-z0-9_]+)/gi
const SQL_MODE_ASSIGNMENT = /\bsql_mode\s*=\s*'/i
const ROW_STATEMENT = /^\s*(?:INSERT|REPLACE)\b/i
const SANDBOX_DIRECTIVE = /^\s*\/\*M!\d+\\?-.*sandbox mode.*\*\/\s*;?\s*$/i
const NO_AUTO_CREATE_USER = 'NO_AUTO_CREATE_USER'

/**
 * Map one MariaDB uca1400 collation name to its MySQL counterpart.
 *
 * `nopad_` is a padding variant MySQL does not spell out in the collation
 * name, so it is stripped and the remaining suffix decides the target. Any
 * suffix that is not one of the four accent/case combinations (locale-specific
 * collations such as `utf8mb4_uca1400_swedish_ai_ci`) falls back to the
 * default `utf8mb4_0900_ai_ci`, because MySQL's locale-tailored collations do
 * not line up one-for-one with MariaDB's.
 */
export function mapUca1400Collation(suffix: string): string {
  return UCA1400_SUFFIX_MAP[normalizeUca1400Suffix(suffix)] ?? UTF8MB4_FALLBACK
}

/**
 * Map one MariaDB utf8mb3 uca1400 collation name to a utf8mb3 collation MySQL
 * has.
 *
 * Same suffix parsing as `mapUca1400Collation`, different target set: MySQL's
 * UCA 9.0.0 collations are utf8mb4 only, so a utf8mb3 column cannot follow the
 * charset it declared into `utf8mb4_0900_*`. What it can keep is case
 * sensitivity, so `_as_cs` and `_ai_cs` (and their `nopad_` forms) map to
 * `utf8mb3_bin` rather than being flattened into a `_ci` collation that would
 * quietly start matching rows the source did not.
 */
export function mapUca1400Utf8mb3Collation(suffix: string): string {
  return CASE_SENSITIVE_SUFFIXES.has(normalizeUca1400Suffix(suffix))
    ? UTF8MB3_CASE_SENSITIVE
    : UTF8MB3_FALLBACK
}

/**
 * `nopad_` is a padding variant MySQL does not spell out in the collation name,
 * so it is stripped before the accent/case suffix is read.
 */
function normalizeUca1400Suffix(suffix: string): string {
  return suffix.toLowerCase().replace(/^nopad_/, '')
}

/**
 * Rewrite one line of a MariaDB dump so a MySQL server accepts it.
 *
 * Pure: the whole contract of the conversion lives here, so it is unit tested
 * line by line rather than by diffing a real dump.
 */
export function normalizeMariaDbDumpForMysql(line: string): NormalizedDumpLine {
  const counts = emptyNormalizationCounts()

  if (SANDBOX_DIRECTIVE.test(line)) {
    counts.sandboxDirectivesDropped = 1
    return { line: null, counts }
  }

  // A row is data, never DDL. A collation name is an ordinary string that a
  // user is entitled to store (a migration log, a schema-tracking table, an
  // ORM's own bookkeeping), and rewriting it would put different bytes in the
  // target than the source holds - the exact outcome the sql_mode rule below
  // already refuses. No INSERT or REPLACE in a dump carries a collation that
  // needs converting, so the whole line is left alone.
  //
  // This guard only sees the line that carries the keyword. An extended insert
  // spans many lines and only the first one starts with `INSERT`, so the rest
  // of the statement is protected by `createMariaDbDumpNormalizer`, not here.
  // Call that, not this, to rewrite a real dump.
  if (ROW_STATEMENT.test(line)) {
    return { line, counts }
  }

  let result = line.replace(UTF8MB4_UCA1400, (_match, suffix: string) => {
    counts.collationsMapped++
    return mapUca1400Collation(suffix)
  })

  result = result.replace(UTF8MB3_UCA1400, (_match, suffix: string) => {
    counts.collationsMapped++
    return mapUca1400Utf8mb3Collation(suffix)
  })

  if (
    result.includes(NO_AUTO_CREATE_USER) &&
    SQL_MODE_ASSIGNMENT.test(result)
  ) {
    result = result.replace(/'([^']*)'/g, (match, contents: string) => {
      if (!contents.includes(NO_AUTO_CREATE_USER)) return match

      const kept = contents
        .split(',')
        .filter((mode) => mode.trim() !== NO_AUTO_CREATE_USER)
      const removed = contents.split(',').length - kept.length
      if (removed === 0) return match

      counts.sqlModeFlagsRemoved += removed
      return `'${kept.join(',')}'`
    })
  }

  return { line: result, counts }
}

/**
 * A statement-aware normalizer over the pure line rules.
 *
 * `mariadb-dump` 11.x writes an extended insert as one statement spread over
 * many lines, one row per line:
 *
 * ```sql
 * INSERT INTO `t_text` VALUES
 * (1,'moved the table to utf8mb4_uca1400_ai_ci last week'),
 * (2,'sql_mode was STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER before');
 * ```
 *
 * Only the first line starts with `INSERT`, so a per-line row guard protects
 * that line and none of the rows under it: a row whose own text names a
 * uca1400 collation was rewritten and arrived in MySQL saying something the
 * source never said. (The `NO_AUTO_CREATE_USER` rule survived this only
 * because it is anchored to a `SET sql_mode` context, which a row line has
 * no reason to match.)
 *
 * So the row guard is carried across lines: once a row statement opens, every
 * line passes through untouched until the statement terminates.
 *
 * **Termination is "the trimmed line ends with `;`".** That is safe for a
 * dump, and only for a dump: `mariadb-dump` (and `mysqldump`) escape `\n` and
 * `\r` inside string literals, so a value never ends a physical line, and the
 * generator always closes the statement at the end of its own line. A
 * hand-written SQL file could end a line with a `;` inside a string literal
 * and close the guard early; a dump cannot, and a dump is the only input this
 * converts.
 *
 * Deliberately unchanged: `LOAD DATA` and a bare `VALUES` statement are not
 * treated as row statements (`mariadb-dump` emits neither in the output we
 * convert, and the rules do not corrupt them), and `/*!...*\/` versioned
 * comment lines keep taking the ordinary rules, which is what strips
 * `NO_AUTO_CREATE_USER` out of the `/*!50003 SET sql_mode = ... *\/` line
 * around every trigger.
 */
export function createMariaDbDumpNormalizer(): {
  next: (line: string) => NormalizedDumpLine
} {
  let inRowStatement = false

  return {
    next(line: string): NormalizedDumpLine {
      const terminates = line.trim().endsWith(';')

      if (inRowStatement) {
        if (terminates) inRowStatement = false
        return { line, counts: emptyNormalizationCounts() }
      }

      const normalized = normalizeMariaDbDumpForMysql(line)
      if (ROW_STATEMENT.test(line) && !terminates) inRowStatement = true

      return normalized
    },
  }
}

/**
 * Stream a MariaDB dump through `createMariaDbDumpNormalizer`, writing the
 * MySQL-ready result to a new file.
 *
 * Line by line with explicit backpressure: a dump is routinely larger than the
 * process can hold, so it is never read into a string.
 *
 * **Read and written as `latin1`, never `utf8`.** A dump is not guaranteed to
 * be valid UTF-8: a `latin1` column, or a BLOB that `mariadb-dump` writes as
 * escaped bytes rather than a hex literal, puts arbitrary bytes above 0x7F in
 * the file. Decoding those as UTF-8 replaces every invalid sequence with
 * U+FFFD, so the conversion silently rewrote the user's data (a `0x80 0xFF`
 * BLOB came out as six `EF BF BD` bytes). `latin1` maps bytes 1:1 to code
 * points 0-255 and back, so the file round-trips byte for byte and only the
 * ASCII tokens the rules match are ever changed. Line splitting stays correct
 * because MySQL escapes `\n` and `\r` inside string literals, so a raw
 * newline byte never appears in dump data.
 */
export async function normalizeMariaDbDumpFile(options: {
  inputPath: string
  outputPath: string
}): Promise<DumpNormalizationCounts> {
  const { inputPath, outputPath } = options
  const counts = emptyNormalizationCounts()

  const input = createReadStream(inputPath, { encoding: 'latin1' })
  const output = createWriteStream(outputPath, { encoding: 'latin1' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  const normalizer = createMariaDbDumpNormalizer()

  try {
    for await (const line of lines) {
      const normalized = normalizer.next(line)
      counts.collationsMapped += normalized.counts.collationsMapped
      counts.sqlModeFlagsRemoved += normalized.counts.sqlModeFlagsRemoved
      counts.sandboxDirectivesDropped +=
        normalized.counts.sandboxDirectivesDropped

      if (normalized.line === null) continue
      if (!output.write(`${normalized.line}\n`)) {
        await once(output, 'drain')
      }
    }
  } finally {
    lines.close()
    output.end()
  }

  await once(output, 'close')
  return counts
}
