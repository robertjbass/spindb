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
})
