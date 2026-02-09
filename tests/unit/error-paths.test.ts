/**
 * Error Path / Negative Tests
 *
 * Tests that invalid inputs produce clear, actionable error messages.
 * Covers SQL injection prevention, validation boundaries, and edge cases.
 */

import { describe, it } from 'node:test'
import {
  isValidUsername,
  assertValidUsername,
  isValidDatabaseName,
  assertValidDatabaseName,
  SpinDBError,
  ErrorCodes,
} from '../../core/error-handler'
import { assert, assertEqual } from '../utils/assertions'

describe('Error Paths', () => {
  // ============================================
  // SQL Injection Prevention via Username Validation
  // ============================================
  describe('SQL injection prevention (usernames)', () => {
    const SQL_INJECTION_USERNAMES = [
      "admin'; DROP TABLE users; --",
      'user" OR "1"="1',
      "'; DELETE FROM test_user; --",
      'admin/**/OR/**/1=1',
      "user' UNION SELECT * FROM pg_shadow --",
      'Robert); DROP TABLE Students;--',
      "admin' AND 1=1 --",
      '1; EXEC xp_cmdshell("cmd")',
    ]

    for (const username of SQL_INJECTION_USERNAMES) {
      it(`should reject SQL injection attempt: "${username.slice(0, 40)}..."`, () => {
        assert(
          !isValidUsername(username),
          `Should reject SQL injection: ${username}`,
        )
      })
    }

    it('should throw SpinDBError with INVALID_USERNAME code for injection attempts', () => {
      try {
        assertValidUsername("admin'; DROP TABLE users; --")
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof SpinDBError, 'Should be SpinDBError')
        assertEqual(
          (error as SpinDBError).code,
          ErrorCodes.INVALID_USERNAME,
          'Should have INVALID_USERNAME code',
        )
      }
    })
  })

  // ============================================
  // SQL Injection Prevention via Database Name Validation
  // ============================================
  describe('SQL injection prevention (database names)', () => {
    const SQL_INJECTION_DB_NAMES = [
      "mydb'; DROP TABLE users; --",
      'db" OR "1"="1',
      '1; EXEC xp_cmdshell("cmd")',
      'db/**/UNION/**/SELECT',
    ]

    for (const dbName of SQL_INJECTION_DB_NAMES) {
      it(`should reject SQL injection in database name: "${dbName.slice(0, 40)}..."`, () => {
        assert(
          !isValidDatabaseName(dbName),
          `Should reject SQL injection: ${dbName}`,
        )
      })
    }

    it('should throw SpinDBError with INVALID_DATABASE_NAME code', () => {
      try {
        assertValidDatabaseName("db'; DROP TABLE users; --")
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof SpinDBError, 'Should be SpinDBError')
        assertEqual(
          (error as SpinDBError).code,
          ErrorCodes.INVALID_DATABASE_NAME,
          'Should have INVALID_DATABASE_NAME code',
        )
      }
    })
  })

  // ============================================
  // Username Edge Cases
  // ============================================
  describe('username edge cases', () => {
    it('should reject empty string', () => {
      assert(!isValidUsername(''), 'Empty string should be invalid')
    })

    it('should reject username starting with number', () => {
      assert(!isValidUsername('1admin'), 'Leading digit should be invalid')
      assert(!isValidUsername('0user'), 'Leading zero should be invalid')
      assert(!isValidUsername('99bottles'), 'Leading digits should be invalid')
    })

    it('should reject username starting with underscore', () => {
      assert(!isValidUsername('_admin'), 'Leading underscore should be invalid')
      assert(!isValidUsername('__user'), 'Double underscore should be invalid')
    })

    it('should reject username with special characters', () => {
      assert(!isValidUsername('user-name'), 'Hyphen should be invalid')
      assert(!isValidUsername('user.name'), 'Dot should be invalid')
      assert(!isValidUsername('user name'), 'Space should be invalid')
      assert(!isValidUsername('user@name'), 'At-sign should be invalid')
      assert(!isValidUsername('user!'), 'Exclamation should be invalid')
      assert(!isValidUsername('user#tag'), 'Hash should be invalid')
      assert(!isValidUsername('user$var'), 'Dollar should be invalid')
    })

    it('should accept maximum length username (63 chars)', () => {
      const maxUsername = 'A' + 'a'.repeat(62)
      assert(isValidUsername(maxUsername), '63-char username should be valid')
    })

    it('should reject username exceeding max length (64+ chars)', () => {
      const tooLong = 'A' + 'a'.repeat(63)
      assert(!isValidUsername(tooLong), '64-char username should be invalid')
    })

    it('should accept single letter username', () => {
      assert(isValidUsername('a'), 'Single lowercase letter should be valid')
      assert(isValidUsername('Z'), 'Single uppercase letter should be valid')
    })

    it('should accept username with mixed case and underscores', () => {
      assert(isValidUsername('App_User_123'), 'Mixed case with underscores')
      assert(isValidUsername('testUser'), 'camelCase')
      assert(isValidUsername('TEST_USER'), 'SCREAMING_SNAKE_CASE')
    })
  })

  // ============================================
  // Database Name Edge Cases
  // ============================================
  describe('database name edge cases', () => {
    it('should reject empty string', () => {
      assert(!isValidDatabaseName(''), 'Empty string should be invalid')
    })

    it('should reject name starting with number', () => {
      assert(!isValidDatabaseName('1mydb'), 'Leading digit should be invalid')
    })

    it('should reject name starting with underscore', () => {
      assert(
        !isValidDatabaseName('_mydb'),
        'Leading underscore should be invalid',
      )
    })

    it('should reject name with hyphens (requires quoted identifiers)', () => {
      assert(!isValidDatabaseName('my-database'), 'Hyphen should be invalid')
    })

    it('should accept valid database names', () => {
      assert(isValidDatabaseName('mydb'), 'Simple name')
      assert(isValidDatabaseName('my_database'), 'With underscore')
      assert(isValidDatabaseName('DB123'), 'With numbers')
      assert(isValidDatabaseName('testDb'), 'camelCase')
    })
  })

  // ============================================
  // Error Message Quality
  // ============================================
  describe('error message quality', () => {
    it('should include the invalid username in error context', () => {
      try {
        assertValidUsername('bad-user!')
        assert(false, 'Should have thrown')
      } catch (error) {
        const err = error as SpinDBError
        assertEqual(
          err.context?.username,
          'bad-user!',
          'Should include username in context',
        )
        assert(
          err.message.includes('bad-user!'),
          'Error message should include the invalid username',
        )
      }
    })

    it('should include the invalid database name in error context', () => {
      try {
        assertValidDatabaseName('bad-db!')
        assert(false, 'Should have thrown')
      } catch (error) {
        const err = error as SpinDBError
        assertEqual(
          err.context?.databaseName,
          'bad-db!',
          'Should include databaseName in context',
        )
        assert(
          err.message.includes('bad-db!'),
          'Error message should include the invalid database name',
        )
      }
    })

    it('should include actionable fix suggestion for username', () => {
      try {
        assertValidUsername('123invalid')
        assert(false, 'Should have thrown')
      } catch (error) {
        const err = error as SpinDBError
        assert(
          err.suggestion !== undefined && err.suggestion.length > 0,
          'Should have a non-empty suggestion',
        )
        assert(
          err.suggestion!.includes('start with a letter'),
          'Suggestion should mention starting with a letter',
        )
      }
    })

    it('should include actionable fix suggestion for database name', () => {
      try {
        assertValidDatabaseName('bad-name')
        assert(false, 'Should have thrown')
      } catch (error) {
        const err = error as SpinDBError
        assert(
          err.suggestion !== undefined && err.suggestion.length > 0,
          'Should have a non-empty suggestion',
        )
        assert(
          err.suggestion!.includes('start with a letter'),
          'Suggestion should mention starting with a letter',
        )
      }
    })
  })
})
