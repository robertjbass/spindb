import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertEqual } from '../utils/assertions'
import {
  buildSurrealUserConnectionString,
  inferSurrealAuthLevel,
  parseSurrealConnectionString,
} from '../../engines/surrealdb/auth'
import { sanitizeBackupContent } from '../../engines/surrealdb/backup'

describe('SurrealDB auth helpers', () => {
  it('uses explicit authLevel from connection strings', () => {
    const connectionString = buildSurrealUserConnectionString({
      username: 'alice',
      password: 'secret',
      port: 8000,
      namespace: 'demo_ns',
      database: 'demo_db',
      authLevel: 'namespace',
    })

    assertEqual(
      inferSurrealAuthLevel({
        username: 'alice',
        database: 'demo_db',
        connectionString,
      }),
      'namespace',
      'Explicit authLevel should win over heuristics',
    )
  })

  it('rejects ambiguous non-root connection strings without authLevel', () => {
    assert.throws(
      () =>
        inferSurrealAuthLevel({
          username: 'alice',
          database: 'demo_db',
          connectionString:
            'surrealdb://alice:secret@127.0.0.1:8000/demo_ns/demo_db',
        }),
      /must include \?authLevel=/,
    )
  })

  it('parses root connection strings without authLevel as root auth', () => {
    const parsed = parseSurrealConnectionString(
      'surrealdb://root:root@127.0.0.1:8000/demo_ns/demo_db',
    )

    assertEqual(parsed.authLevel, 'root', 'Root auth should remain implicit')
  })
})

describe('sanitizeBackupContent', () => {
  it('removes auth statements even when quoted values contain semicolons', () => {
    const content = [
      "DEFINE USER app ON ROOT PASSWORD 'abc;123' ROLES OWNER;",
      'DEFINE ACCESS api ON DATABASE TYPE RECORD SIGNUP NONE SIGNIN NONE;',
      'OPTION IMPORT;',
      'USE NS demo_ns;',
      'USE DB demo_db;',
      "CREATE item:1 SET password = 'keep;this';",
    ].join('\n')

    const sanitized = sanitizeBackupContent(content)

    assert.equal(
      sanitized.includes('DEFINE USER app'),
      false,
      'DEFINE USER should be stripped',
    )
    assert.equal(
      sanitized.includes('DEFINE ACCESS api'),
      false,
      'DEFINE ACCESS should be stripped',
    )
    assert.equal(
      sanitized.includes('OPTION IMPORT'),
      false,
      'OPTION IMPORT should be stripped',
    )
    assert.equal(
      sanitized.includes('USE NS demo_ns'),
      false,
      'USE NS should be stripped',
    )
    assert.equal(
      sanitized.includes('USE DB demo_db'),
      false,
      'USE DB should be stripped',
    )
    assertEqual(
      sanitized.includes("CREATE item:1 SET password = 'keep;this';"),
      true,
      'Data statements with semicolons inside quoted strings should be preserved',
    )
  })
})
