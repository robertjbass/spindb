import { describe, it } from 'node:test'
import assert from 'node:assert'
import { buildWindowsPsqlCommand } from '../../engines/postgresql/index.ts'

describe('PostgreSQL Windows command builder', () => {
  it('builds command for SQL file with spaces in path', () => {
    const cmd = buildWindowsPsqlCommand(
      'C:\\Program Files\\postgres\\bin\\psql.exe',
      5454,
      'postgres',
      'testdb',
      { file: 'C:\\path with spaces\\seed.sql' },
    )

    assert.strictEqual(
      cmd,
      '"C:\\Program Files\\postgres\\bin\\psql.exe" -h 127.0.0.1 -p 5454 -U postgres -d testdb -f "C:\\path with spaces\\seed.sql"',
    )
  })

  it('escapes double quotes in inline SQL', () => {
    const sql = 'INSERT INTO "user" (name) VALUES("Alice")'
    const cmd = buildWindowsPsqlCommand(
      'C:\\bin\\psql.exe',
      5454,
      'postgres',
      'testdb',
      { sql },
    )

    const escaped = sql.replace(/"/g, '\\"')
    assert.strictEqual(
      cmd,
      `"C:\\bin\\psql.exe" -h 127.0.0.1 -p 5454 -U postgres -d testdb -c "${escaped}"`,
    )
  })
})
