import { describe, it } from 'node:test'
import assert from 'node:assert'
import { buildWindowsMysqlCommand } from '../../engines/mysql'

describe('MySQL Windows command builder', () => {
  it('builds command for SQL file with spaces in path', () => {
    const cmd = buildWindowsMysqlCommand(
      'C:\\Program Files\\MySQL\\bin\\mysql.exe',
      3333,
      'root',
      'testdb',
      { file: 'C:\\path with spaces\\seed.sql' },
    )

    assert.strictEqual(
      cmd,
      '"C:\\Program Files\\MySQL\\bin\\mysql.exe" -h 127.0.0.1 -P 3333 -u root testdb < "C:\\path with spaces\\seed.sql"',
    )
  })

  it('escapes double quotes in inline SQL', () => {
    const sql = 'INSERT INTO `user` (name) VALUES("Alice")'
    const cmd = buildWindowsMysqlCommand(
      'C:\\bin\\mysql.exe',
      3333,
      'root',
      'testdb',
      { sql },
    )

    assert.strictEqual(
      cmd,
      '"C:\\bin\\mysql.exe" -h 127.0.0.1 -P 3333 -u root testdb -e "INSERT INTO `user` (name) VALUES(\\"Alice\\")"',
    )
  })
})
