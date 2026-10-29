import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MysqlImportDefiners,
  normalizeRemoteDumpDefiners,
} from '../../core/mysql-import-definers'

async function rewrite(input: Buffer | string, chunkSize = 65536) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const chunks: Buffer[] = []
  for (let i = 0; i < source.length; i += chunkSize)
    chunks.push(source.subarray(i, i + chunkSize))
  const transform = new MysqlImportDefiners()
  const output: Buffer[] = []
  await pipeline(
    Readable.from(chunks),
    transform,
    new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk)
        callback()
      },
    }),
  )
  return { output: Buffer.concat(output), count: transform.count }
}

describe('remote MySQL-family import definers', () => {
  it('rewrites views, triggers, procedures, functions and events across every chunk boundary', async () => {
    const input = [
      'CREATE ALGORITHM=UNDEFINED DEFINER=`old``user`@`%` SQL SECURITY DEFINER VIEW v AS SELECT 1;\r\n',
      "/*!50003 CREATE*/ /*!50017 DEFINER='old\\'user'@'host'*/ /*!50003 TRIGGER tr BEFORE INSERT ON t FOR EACH ROW SET NEW.n=1 */;\n",
      'CREATE DEFINER="old"@"host" PROCEDURE p() SELECT 1;\n',
      'CREATE OR REPLACE DEFINER=old@localhost FUNCTION f() RETURNS INT RETURN 1;\n',
      '/*M!100100 CREATE DEFINER = old @ 127.0.0.1 EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1 */;',
    ].join('')
    const expected = input
      .replace(/DEFINER=`old``user`@`%`/, 'DEFINER=CURRENT_USER')
      .replace("DEFINER='old\\'user'@'host'", 'DEFINER=CURRENT_USER')
      .replace('DEFINER="old"@"host"', 'DEFINER=CURRENT_USER')
      .replace('DEFINER=old@localhost', 'DEFINER=CURRENT_USER')
      .replace('DEFINER = old @ 127.0.0.1', 'DEFINER=CURRENT_USER')
    for (const size of [1, 2, 3, 4, 7, 19, 65536]) {
      const result = await rewrite(input, size)
      assert.equal(result.output.toString(), expected, `chunk size ${size}`)
      assert.equal(result.count, 5)
    }
  })

  it('preserves arbitrary data bytes, comments, identifiers and existing CURRENT_USER owners', async () => {
    const input = Buffer.concat([
      Buffer.from(
        "-- CREATE DEFINER=old@host VIEW v\r\n# CREATE DEFINER=old@host VIEW v\n/* CREATE DEFINER=old@host VIEW v */\nINSERT INTO t VALUES ('CREATE DEFINER=old@host VIEW v',\n'it\\'s DEFINER=old@host',\"DEFINER=old@host\");\nCREATE TABLE t (`DEFINER=old@host` text);\nCREATE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW v AS SELECT 'DEFINER=old@host';\n",
      ),
      Buffer.from([0x80, 0xff, 0x0d, 0x0a]),
    ])
    for (const size of [1, 17, 65536]) {
      const result = await rewrite(input, size)
      assert.deepEqual(result.output, input)
      assert.equal(result.count, 0)
    }
  })

  it('does not buffer or rewrite giant row literals or comments', async () => {
    const input =
      "INSERT INTO t VALUES ('" +
      'x'.repeat(200000) +
      " CREATE DEFINER=old@host VIEW v');\n/*" +
      'x'.repeat(200000) +
      '*/\nCREATE DEFINER=old@host VIEW v AS SELECT 1;'
    const result = await rewrite(input, 31)
    assert.equal(
      result.output.toString(),
      input.replace(
        'CREATE DEFINER=old@host VIEW v AS SELECT',
        'CREATE DEFINER=CURRENT_USER VIEW v AS SELECT',
      ),
    )
    assert.equal(result.count, 1)
  })

  it('preserves incomplete account clauses for the server to reject', async () => {
    for (const input of [
      'CREATE DEFINER=',
      "CREATE DEFINER='old'@",
      'CREATE DEFINER=old VIEW v AS SELECT 1;',
    ]) {
      const result = await rewrite(input, 1)
      assert.equal(result.output.toString(), input)
      assert.equal(result.count, 0)
    }
  })
})

it('keeps executable comment wrappers and SQL SECURITY clauses intact', async () => {
  const input =
    '/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=`old`@`%` SQL SECURITY DEFINER */\n/*!50001 VIEW `v` AS SELECT 1 */;'
  const result = await rewrite(input, 1)
  assert.equal(
    result.output.toString(),
    input.replace('DEFINER=`old`@`%`', 'DEFINER=CURRENT_USER'),
  )
  assert.equal(result.count, 1)
})

it('reports rewrite counts alongside existing conversions and cleans temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'definer-report-'))
  const filePath = join(directory, 'dump.sql')
  try {
    await writeFile(filePath, 'CREATE DEFINER=old@host VIEW v AS SELECT 1;')
    const result = await normalizeRemoteDumpDefiners({
      filePath,
      warnings: ['existing warning'],
      remoteSource: {
        flavor: 'mariadb',
        dumpTool: 'mariadb-dump',
        rewrites: { collationsMapped: 2 },
      },
    })
    assert.deepEqual(result.remoteSource?.rewrites, {
      collationsMapped: 2,
      definersRewritten: 1,
    })
    assert.equal(result.warnings?.length, 2)
    assert.equal(
      await readFile(filePath, 'utf8'),
      'CREATE DEFINER=CURRENT_USER VIEW v AS SELECT 1;',
    )
    assert.deepEqual(await readdir(directory), ['dump.sql'])
    await assert.rejects(
      normalizeRemoteDumpDefiners({ filePath: join(directory, 'missing.sql') }),
      /ENOENT/,
    )
    assert.deepEqual(await readdir(directory), ['dump.sql'])
    const unchanged = Buffer.from([0xff, 0x80, 0x0d, 0x0a])
    await writeFile(filePath, unchanged)
    const noDefinitions = await normalizeRemoteDumpDefiners({ filePath })
    assert.equal(noDefinitions.remoteSource?.rewrites?.definersRewritten, 0)
    assert.deepEqual(await readFile(filePath), unchanged)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not remove executable-comment boundaries inside an unusual account clause', async () => {
  const input =
    '/*!50001 CREATE DEFINER=old */ /*!50001 @host VIEW v AS SELECT 1 */;'
  const result = await rewrite(input, 1)
  assert.equal(result.output.toString(), input)
  assert.equal(result.count, 0)
})

it('tracks dump SQL_MODE save/restore without treating a literal backslash as an escape', async () => {
  const input = [
    "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
    '/*!50003 SET @saved_sql_mode = @@sql_mode */;',
    "/*!50003 SET sql_mode = 'NO_BACKSLASH_ESCAPES' */;",
    "INSERT INTO t VALUES ('trailing\\');",
    "CREATE DEFINER='old'@'host' VIEW v AS SELECT 'literal\\';",
    '/*!50003 SET sql_mode = @saved_sql_mode */;',
    "CREATE DEFINER='old'@'host' VIEW w AS SELECT 'it\\'s data';",
    '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;',
  ].join('\n')
  for (const size of [1, 65536]) {
    const result = await rewrite(input, size)
    assert.equal(
      result.output.toString(),
      input.replaceAll("DEFINER='old'@'host'", 'DEFINER=CURRENT_USER'),
    )
    assert.equal(result.count, 2)
  }
})
