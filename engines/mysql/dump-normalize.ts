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
 * stream and never held in memory.
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
    SQL_MODE_ASSIGNMENT.test(result) &&
    !ROW_STATEMENT.test(result)
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
 * Stream a MariaDB dump through `normalizeMariaDbDumpForMysql`, writing the
 * MySQL-ready result to a new file.
 *
 * Line by line with explicit backpressure: a dump is routinely larger than the
 * process can hold, so it is never read into a string.
 */
export async function normalizeMariaDbDumpFile(options: {
  inputPath: string
  outputPath: string
}): Promise<DumpNormalizationCounts> {
  const { inputPath, outputPath } = options
  const counts = emptyNormalizationCounts()

  const input = createReadStream(inputPath, { encoding: 'utf8' })
  const output = createWriteStream(outputPath)
  const lines = createInterface({ input, crlfDelay: Infinity })

  try {
    for await (const line of lines) {
      const normalized = normalizeMariaDbDumpForMysql(line)
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
