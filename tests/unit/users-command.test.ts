import { describe, it } from 'node:test'
import {
  isValidUsername,
  assertValidUsername,
  SpinDBError,
  ErrorCodes,
} from '../../core/error-handler'
import { assert, assertEqual } from '../utils/assertions'

describe('Username Validation', () => {
  describe('isValidUsername', () => {
    it('should accept valid usernames', () => {
      assert(isValidUsername('alice'), 'Simple lowercase name')
      assert(isValidUsername('Bob'), 'Capitalized name')
      assert(isValidUsername('app_user'), 'Name with underscore')
      assert(isValidUsername('user123'), 'Name with numbers')
      assert(isValidUsername('a'), 'Single letter')
      assert(isValidUsername('A'.repeat(63)), 'Max length (63 characters)')
    })

    it('should reject invalid usernames', () => {
      assert(!isValidUsername(''), 'Empty string')
      assert(!isValidUsername('123user'), 'Starting with number')
      assert(!isValidUsername('_user'), 'Starting with underscore')
      assert(!isValidUsername('user-name'), 'Containing hyphen')
      assert(!isValidUsername('user.name'), 'Containing dot')
      assert(!isValidUsername('user name'), 'Containing space')
      assert(!isValidUsername("user'name"), 'Containing single quote')
      assert(!isValidUsername('user"name'), 'Containing double quote')
      assert(
        !isValidUsername('A'.repeat(64)),
        'Exceeding max length (64 characters)',
      )
    })
  })

  describe('assertValidUsername', () => {
    it('should not throw for valid usernames', () => {
      assertValidUsername('appuser')
      assertValidUsername('test_user_123')
    })

    it('should throw SpinDBError for invalid usernames', () => {
      try {
        assertValidUsername('123invalid')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof SpinDBError, 'Should be SpinDBError')
        assertEqual(
          (error as SpinDBError).code,
          ErrorCodes.INVALID_USERNAME,
          'Should have correct error code',
        )
      }
    })

    it('should include username in error context', () => {
      try {
        assertValidUsername('bad-name')
        assert(false, 'Should have thrown')
      } catch (error) {
        const err = error as SpinDBError
        assertEqual(
          err.context?.username,
          'bad-name',
          'Should include username in context',
        )
      }
    })
  })

  describe('SQL injection prevention', () => {
    it('should reject common SQL injection patterns', () => {
      assert(
        !isValidUsername("admin'; DROP TABLE users; --"),
        'SQL injection with semicolon',
      )
      assert(!isValidUsername('user" OR "1"="1'), 'SQL injection with quotes')
      assert(
        !isValidUsername("'; DELETE FROM test; --"),
        'SQL delete injection',
      )
      assert(!isValidUsername('admin/**/OR/**/1=1'), 'SQL comment injection')
    })

    it('should throw SpinDBError for SQL injection attempts', () => {
      try {
        assertValidUsername("admin'; DROP TABLE users; --")
        assert(false, 'Should have thrown for SQL injection')
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

  describe('boundary values', () => {
    it('should accept exactly 63 characters', () => {
      const name = 'A' + 'b'.repeat(62)
      assert(isValidUsername(name), '63 chars should be valid')
    })

    it('should reject exactly 64 characters', () => {
      const name = 'A' + 'b'.repeat(63)
      assert(!isValidUsername(name), '64 chars should be invalid')
    })

    it('should accept single character names', () => {
      assert(isValidUsername('a'), 'Single lowercase')
      assert(isValidUsername('Z'), 'Single uppercase')
    })

    it('should reject whitespace-only strings', () => {
      assert(!isValidUsername(' '), 'Single space')
      assert(!isValidUsername('\t'), 'Tab')
      assert(!isValidUsername('\n'), 'Newline')
    })

    it('should reject unicode characters', () => {
      assert(!isValidUsername('user\u0000'), 'Null byte')
      assert(!isValidUsername('caf\u00e9'), 'Accented character')
    })
  })
})
