import { describe, it } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  normalizeMariaDbDumpForMysql,
  normalizeMariaDbDumpFile,
  mapUca1400Collation,
  mapUca1400Utf8mb3Collation,
  totalRewrites,
} from '../../engines/mysql/dump-normalize'
import { assert, assertEqual } from '../utils/assertions'

function rewrite(line: string): string {
  const result = normalizeMariaDbDumpForMysql(line)
  assert(result.line !== null, `line should be kept: ${line}`)
  return result.line!
}

describe('MariaDB dump normalization: collations', () => {
  it('maps the MariaDB 11 default collation to its MySQL counterpart', () => {
    // MariaDB 11.4 made utf8mb4_uca1400_ai_ci the default database collation,
    // so nearly every CREATE TABLE in a modern dump carries it and every one
    // of them fails on MySQL, which has never had a uca1400 collation.
    const result = normalizeMariaDbDumpForMysql(
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;',
    )

    assertEqual(
      result.line,
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
      'the table collation should become MySQL 0900',
    )
    assertEqual(result.counts.collationsMapped, 1, 'one collation mapped')
  })

  it('keeps the accent and case sensitivity the schema asked for', () => {
    assertEqual(
      mapUca1400Collation('as_cs'),
      'utf8mb4_0900_as_cs',
      'accent and case sensitive',
    )
    assertEqual(
      mapUca1400Collation('as_ci'),
      'utf8mb4_0900_as_ci',
      'accent sensitive, case insensitive',
    )
    assertEqual(
      mapUca1400Collation('ai_ci'),
      'utf8mb4_0900_ai_ci',
      'accent and case insensitive',
    )
  })

  it('maps ai_cs to as_cs, the closest MySQL has', () => {
    // MySQL has no accent-insensitive-but-case-sensitive utf8mb4 collation, so
    // the case sensitivity is honored and the accent handling is not.
    assertEqual(
      mapUca1400Collation('ai_cs'),
      'utf8mb4_0900_as_cs',
      'closest available',
    )
  })

  it('treats a nopad variant as its padded equivalent', () => {
    assertEqual(
      rewrite(
        '`name` varchar(64) COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL',
      ),
      '`name` varchar(64) COLLATE utf8mb4_0900_as_cs NOT NULL',
      'nopad_as_cs follows as_cs',
    )
  })

  it('falls back to the default collation for a locale-specific one', () => {
    // MySQL's locale-tailored collations do not line up one-for-one with
    // MariaDB's, so a Swedish uca1400 collation takes the default rather than
    // a wrong-looking exact-sounding name.
    assertEqual(
      rewrite('COLLATE=utf8mb4_uca1400_swedish_ai_ci;'),
      'COLLATE=utf8mb4_0900_ai_ci;',
      'unknown suffix takes the default',
    )
  })

  it('maps utf8mb3 uca1400 collations to a utf8mb3 collation MySQL has', () => {
    assertEqual(
      rewrite('COLLATE=utf8mb3_uca1400_ai_ci;'),
      'COLLATE=utf8mb3_unicode_ci;',
      'utf8mb3 target',
    )
    assertEqual(
      rewrite('COLLATE=utf8_uca1400_as_ci;'),
      'COLLATE=utf8mb3_unicode_ci;',
      'the utf8 alias takes the same target',
    )
  })

  it('keeps case sensitivity on a utf8mb3 collation', () => {
    // MySQL's UCA 9.0.0 collations are utf8mb4 only, so a case-sensitive
    // utf8mb3 column has nowhere to go but utf8mb3_bin. Flattening it into
    // utf8mb3_unicode_ci would silently start matching rows the source did
    // not.
    assertEqual(
      mapUca1400Utf8mb3Collation('as_cs'),
      'utf8mb3_bin',
      'accent and case sensitive',
    )
    assertEqual(
      mapUca1400Utf8mb3Collation('ai_cs'),
      'utf8mb3_bin',
      'case sensitive is the half that can be kept',
    )
    assertEqual(
      mapUca1400Utf8mb3Collation('nopad_as_cs'),
      'utf8mb3_bin',
      'a nopad variant follows its padded equivalent',
    )
    assertEqual(
      mapUca1400Utf8mb3Collation('ai_ci'),
      'utf8mb3_unicode_ci',
      'case insensitive keeps UCA ordering',
    )
    assertEqual(
      mapUca1400Utf8mb3Collation('swedish_ai_ci'),
      'utf8mb3_unicode_ci',
      'a locale-specific collation takes the default',
    )
    assertEqual(
      rewrite('`name` varchar(64) COLLATE utf8mb3_uca1400_ai_cs NOT NULL'),
      '`name` varchar(64) COLLATE utf8mb3_bin NOT NULL',
      'through the line rewrite too',
    )
  })

  it('maps every collation on a line, not just the first', () => {
    const result = normalizeMariaDbDumpForMysql(
      '`a` text COLLATE utf8mb4_uca1400_ai_ci, `b` text COLLATE utf8mb4_uca1400_as_cs',
    )

    assertEqual(
      result.line,
      '`a` text COLLATE utf8mb4_0900_ai_ci, `b` text COLLATE utf8mb4_0900_as_cs',
      'both collations rewritten',
    )
    assertEqual(result.counts.collationsMapped, 2, 'two collations mapped')
  })

  it('does not touch row data that happens to name a uca1400 collation', () => {
    // A collation name is an ordinary string a user is entitled to store (a
    // migration log, a schema-tracking table). Rewriting it would put
    // different bytes in the target than the source holds, which is worse
    // than the error the rule exists to avoid.
    const line =
      "INSERT INTO `migration_log` VALUES (1,'moved the table to utf8mb4_uca1400_ai_ci');"
    const result = normalizeMariaDbDumpForMysql(line)

    assertEqual(result.line, line, 'row data is untouched')
    assertEqual(result.counts.collationsMapped, 0, 'nothing mapped')
  })

  it('does not touch a REPLACE row either', () => {
    const line =
      "REPLACE INTO `notes` VALUES (2,'utf8mb3_uca1400_as_cs is MariaDB only');"
    const result = normalizeMariaDbDumpForMysql(line)

    assertEqual(result.line, line, 'row data is untouched')
    assertEqual(totalRewrites(result.counts), 0, 'nothing rewritten')
  })

  it('leaves a collation MySQL already has alone', () => {
    const line =
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;'
    const result = normalizeMariaDbDumpForMysql(line)

    assertEqual(result.line, line, 'unchanged')
    assertEqual(totalRewrites(result.counts), 0, 'nothing rewritten')
  })
})

describe('MariaDB dump normalization: sql_mode', () => {
  it('removes NO_AUTO_CREATE_USER from the middle of a mode list', () => {
    // MySQL 8 removed the mode and answers ERROR 1231 for it, which is what
    // breaks every trigger and routine in a MariaDB dump.
    const result = normalizeMariaDbDumpForMysql(
      "/*!50003 SET sql_mode = 'STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;",
    )

    assertEqual(
      result.line,
      "/*!50003 SET sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION' */ ;",
      'the mode is removed and the commas stay balanced',
    )
    assertEqual(result.counts.sqlModeFlagsRemoved, 1, 'one mode removed')
  })

  it('removes it from the front of a mode list', () => {
    assertEqual(
      rewrite("SET sql_mode='NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';"),
      "SET sql_mode='NO_ENGINE_SUBSTITUTION';",
      'no leading comma left behind',
    )
  })

  it('removes it from the end of a mode list', () => {
    assertEqual(
      rewrite("SET sql_mode='STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER';"),
      "SET sql_mode='STRICT_TRANS_TABLES';",
      'no trailing comma left behind',
    )
  })

  it('leaves an empty mode list when it was the only mode', () => {
    assertEqual(
      rewrite("SET sql_mode='NO_AUTO_CREATE_USER';"),
      "SET sql_mode='';",
      'an empty sql_mode is valid; a dangling comma is not',
    )
  })

  it('does not touch row data that happens to contain the name', () => {
    // Rewriting a user's data would be far worse than the error we are
    // avoiding, so the rule only fires on a sql_mode assignment.
    const line =
      "INSERT INTO `audit` VALUES (1,'sql_mode=\\'NO_AUTO_CREATE_USER\\' was removed');"
    const result = normalizeMariaDbDumpForMysql(line)

    assertEqual(result.line, line, 'row data is untouched')
    assertEqual(result.counts.sqlModeFlagsRemoved, 0, 'nothing removed')
  })

  it('leaves a mode list that does not contain it alone', () => {
    const line =
      "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;"
    const result = normalizeMariaDbDumpForMysql(line)

    assertEqual(result.line, line, 'unchanged')
    assertEqual(totalRewrites(result.counts), 0, 'nothing rewritten')
  })
})

describe('MariaDB dump normalization: sandbox directive', () => {
  it('drops the sandbox line mariadb-dump opens every dump with', () => {
    const result = normalizeMariaDbDumpForMysql(
      '/*M!999999\\- enable the sandbox mode */',
    )

    assertEqual(result.line, null, 'the line is dropped entirely')
    assertEqual(result.counts.sandboxDirectivesDropped, 1, 'counted')
  })

  it('leaves an ordinary MariaDB versioned comment alone', () => {
    const line = '/*M!100616 SET @@SESSION.SQL_LOG_BIN=0 */;'
    const result = normalizeMariaDbDumpForMysql(line)

    assertEqual(result.line, line, 'unchanged')
    assertEqual(totalRewrites(result.counts), 0, 'nothing rewritten')
  })
})

describe('MariaDB dump normalization: statements left to fail', () => {
  it('does not invent a MySQL equivalent for MariaDB-only objects', () => {
    // Sequences and MariaDB-only types have no MySQL counterpart. Substituting
    // one would put different data in the target than the source holds, so
    // they are left to fail with the server's own error.
    const untouched = [
      'CREATE SEQUENCE `order_seq` START WITH 1 INCREMENT BY 1;',
      '`id` uuid NOT NULL DEFAULT uuid(),',
      '`addr` inet6 DEFAULT NULL,',
      '`embedding` vector(1536) NOT NULL,',
      '`counter` bigint NOT NULL DEFAULT nextval(`order_seq`),',
      // MySQL has json_valid(), so a CHECK constraint using it needs no help.
      '`doc` json DEFAULT NULL CHECK (json_valid(`doc`)),',
    ]

    for (const line of untouched) {
      const result = normalizeMariaDbDumpForMysql(line)
      assertEqual(result.line, line, `unchanged: ${line}`)
      assertEqual(totalRewrites(result.counts), 0, `no rewrites: ${line}`)
    }
  })

  it('leaves an ordinary line untouched', () => {
    const line = "INSERT INTO `test_user` VALUES (1,'Ada','ada@example.com');"
    const result = normalizeMariaDbDumpForMysql(line)

    assertEqual(result.line, line, 'unchanged')
    assertEqual(totalRewrites(result.counts), 0, 'nothing rewritten')
  })
})

describe('normalizeMariaDbDumpFile', () => {
  it('rewrites a whole dump as a stream and reports what it changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spindb-normalize-'))
    const inputPath = join(dir, 'source.sql')
    const outputPath = join(dir, 'converted.sql')

    const dump = [
      '/*M!999999\\- enable the sandbox mode */',
      '-- MariaDB dump 10.19  Distrib 11.8.8-MariaDB',
      '/*!40101 SET NAMES utf8mb4 */;',
      'CREATE TABLE `test_user` (',
      '  `id` int NOT NULL AUTO_INCREMENT,',
      '  `name` varchar(64) COLLATE utf8mb4_uca1400_ai_ci NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;',
      "INSERT INTO `test_user` VALUES (1,'Ada');",
      "/*!50003 SET sql_mode = 'STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER' */ ;",
      'CREATE TRIGGER `stamp` BEFORE INSERT ON `test_user` FOR EACH ROW SET @x = 1;',
    ].join('\n')
    await writeFile(inputPath, `${dump}\n`)

    const counts = await normalizeMariaDbDumpFile({ inputPath, outputPath })
    const converted = await readFile(outputPath, 'utf8')

    try {
      assertEqual(counts.collationsMapped, 2, 'both collations mapped')
      assertEqual(counts.sqlModeFlagsRemoved, 1, 'one sql_mode flag removed')
      assertEqual(counts.sandboxDirectivesDropped, 1, 'sandbox line dropped')

      assert(
        !converted.includes('uca1400'),
        'no uca1400 collation should survive',
      )
      assert(
        !converted.includes('NO_AUTO_CREATE_USER'),
        'no removed sql_mode should survive',
      )
      assert(
        !converted.includes('sandbox mode'),
        'the sandbox directive should be gone',
      )
      assert(
        converted.includes("INSERT INTO `test_user` VALUES (1,'Ada');"),
        'row data should be carried through unchanged',
      )
      assert(
        converted.includes('CREATE TRIGGER `stamp`'),
        'the trigger should be carried through',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('carries bytes that are not valid UTF-8 through untouched', async () => {
    // mariadb-dump writes a BLOB (and a latin1 column) as escaped raw bytes,
    // not as a hex literal, so a dump is not guaranteed to be valid UTF-8.
    // Reading it as UTF-8 turned every invalid sequence into U+FFFD, which is
    // silent corruption of the user's data.
    const dir = await mkdtemp(join(tmpdir(), 'spindb-normalize-bytes-'))
    const inputPath = join(dir, 'source.sql')
    const outputPath = join(dir, 'converted.sql')

    const source = Buffer.concat([
      Buffer.from(') ENGINE=InnoDB COLLATE=utf8mb4_uca1400_ai_ci;\n'),
      Buffer.from("INSERT INTO `blobs` VALUES (1,'"),
      Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x80, 0xff]),
      Buffer.from("');\n"),
    ])
    await writeFile(inputPath, source)

    try {
      const counts = await normalizeMariaDbDumpFile({ inputPath, outputPath })
      const converted = await readFile(outputPath)

      assertEqual(counts.collationsMapped, 1, 'the DDL line is still rewritten')
      assertEqual(
        converted.toString('latin1'),
        source
          .toString('latin1')
          .replace('utf8mb4_uca1400_ai_ci', 'utf8mb4_0900_ai_ci'),
        'every byte outside the rewritten token survives unchanged',
      )
      assert(
        converted.includes(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x80, 0xff])),
        'the raw blob bytes should survive byte for byte',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
