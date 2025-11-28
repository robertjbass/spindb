/**
 * Unit tests for error-handler module
 */

import { describe, it } from 'node:test'
import {
  SpinDBError,
  ErrorCodes,
  createPortInUseError,
  createContainerNotFoundError,
  createVersionMismatchError,
  createDependencyMissingError,
} from '../../core/error-handler'
import { assert, assertEqual } from '../integration/helpers'

describe('SpinDBError', () => {
  it('should create error with all properties', () => {
    const error = new SpinDBError(
      ErrorCodes.PORT_IN_USE,
      'Port 5432 is in use',
      'error',
      'Use a different port',
      { port: 5432 },
    )

    assertEqual(error.code, ErrorCodes.PORT_IN_USE, 'Error code should match')
    assertEqual(error.message, 'Port 5432 is in use', 'Message should match')
    assertEqual(error.severity, 'error', 'Severity should match')
    assertEqual(
      error.suggestion,
      'Use a different port',
      'Suggestion should match',
    )
    assertEqual(error.context?.port, 5432, 'Context should contain port')
    assert(error instanceof Error, 'Should be instance of Error')
    assert(error.name === 'SpinDBError', 'Name should be SpinDBError')
  })

  it('should create error with default severity', () => {
    const error = new SpinDBError(
      ErrorCodes.UNKNOWN_ERROR,
      'Something went wrong',
    )

    assertEqual(error.severity, 'error', 'Default severity should be error')
    assert(error.suggestion === undefined, 'Suggestion should be undefined')
    assert(error.context === undefined, 'Context should be undefined')
  })

  it('should create error from unknown error via SpinDBError.from()', () => {
    const originalError = new Error('Original error message')
    const spindbError = SpinDBError.from(
      originalError,
      ErrorCodes.UNKNOWN_ERROR,
    )

    assertEqual(spindbError.code, ErrorCodes.UNKNOWN_ERROR, 'Code should match')
    assertEqual(
      spindbError.message,
      'Original error message',
      'Message should come from original',
    )
    assert(
      spindbError.context?.originalError !== undefined,
      'Should include original stack',
    )
  })

  it('should return same error if already SpinDBError', () => {
    const original = new SpinDBError(ErrorCodes.PORT_IN_USE, 'Port in use')
    const result = SpinDBError.from(original)

    assert(result === original, 'Should return same instance')
  })

  it('should convert string to SpinDBError', () => {
    const error = SpinDBError.from('String error message')

    assertEqual(
      error.message,
      'String error message',
      'Message should match string',
    )
    assertEqual(
      error.code,
      ErrorCodes.UNKNOWN_ERROR,
      'Should use unknown error code',
    )
  })
})

describe('Error Creation Helpers', () => {
  describe('createPortInUseError', () => {
    it('should create port-in-use error with correct properties', () => {
      const error = createPortInUseError(5432)

      assertEqual(
        error.code,
        ErrorCodes.PORT_IN_USE,
        'Code should be PORT_IN_USE',
      )
      assert(error.message.includes('5432'), 'Message should include port')
      assert(error.suggestion !== undefined, 'Should have suggestion')
      assert(
        error.suggestion!.includes('5432'),
        'Suggestion should mention port',
      )
      assertEqual(error.context?.port, 5432, 'Context should contain port')
    })
  })

  describe('createContainerNotFoundError', () => {
    it('should create container-not-found error with correct properties', () => {
      const error = createContainerNotFoundError('mydb')

      assertEqual(
        error.code,
        ErrorCodes.CONTAINER_NOT_FOUND,
        'Code should be CONTAINER_NOT_FOUND',
      )
      assert(
        error.message.includes('mydb'),
        'Message should include container name',
      )
      assert(
        error.suggestion!.includes('spindb list'),
        'Suggestion should mention list command',
      )
      assertEqual(
        error.context?.containerName,
        'mydb',
        'Context should contain container name',
      )
    })
  })

  describe('createVersionMismatchError', () => {
    it('should create version-mismatch error with correct properties', () => {
      const error = createVersionMismatchError('17', '15')

      assertEqual(
        error.code,
        ErrorCodes.VERSION_MISMATCH,
        'Code should be VERSION_MISMATCH',
      )
      assert(
        error.message.includes('17'),
        'Message should include dump version',
      )
      assert(
        error.message.includes('15'),
        'Message should include tool version',
      )
      assertEqual(error.severity, 'fatal', 'Should be fatal severity')
      assert(
        error.suggestion!.includes('brew install'),
        'Suggestion should include install command',
      )
      assertEqual(
        error.context?.dumpVersion,
        '17',
        'Context should contain dump version',
      )
      assertEqual(
        error.context?.toolVersion,
        '15',
        'Context should contain tool version',
      )
    })
  })

  describe('createDependencyMissingError', () => {
    it('should create dependency-missing error for psql', () => {
      const error = createDependencyMissingError('psql', 'postgresql')

      assertEqual(
        error.code,
        ErrorCodes.DEPENDENCY_MISSING,
        'Code should be DEPENDENCY_MISSING',
      )
      assert(error.message.includes('psql'), 'Message should include tool name')
      assert(
        error.suggestion!.includes('libpq'),
        'Suggestion should mention libpq for psql',
      )
      assertEqual(
        error.context?.toolName,
        'psql',
        'Context should contain tool name',
      )
      assertEqual(
        error.context?.engine,
        'postgresql',
        'Context should contain engine',
      )
    })

    it('should create dependency-missing error for mysql', () => {
      const error = createDependencyMissingError('mysql', 'mysql')

      assert(
        error.suggestion!.includes('mysql-client'),
        'Suggestion should mention mysql-client',
      )
    })

    it('should create generic suggestion for unknown tool', () => {
      const error = createDependencyMissingError('unknown-tool', 'postgresql')

      assert(
        error.suggestion!.includes('postgresql client tools'),
        'Should have generic suggestion',
      )
    })
  })
})

describe('ErrorCodes', () => {
  it('should have unique values for all codes', () => {
    const values = Object.values(ErrorCodes)
    const uniqueValues = new Set(values)

    assertEqual(
      values.length,
      uniqueValues.size,
      'All error codes should be unique',
    )
  })

  it('should include all expected categories', () => {
    // Port errors
    assert('PORT_IN_USE' in ErrorCodes, 'Should have PORT_IN_USE')
    assert(
      'PORT_PERMISSION_DENIED' in ErrorCodes,
      'Should have PORT_PERMISSION_DENIED',
    )
    assert(
      'PORT_RANGE_EXHAUSTED' in ErrorCodes,
      'Should have PORT_RANGE_EXHAUSTED',
    )

    // Process errors
    assert(
      'PROCESS_START_FAILED' in ErrorCodes,
      'Should have PROCESS_START_FAILED',
    )
    assert(
      'PROCESS_STOP_TIMEOUT' in ErrorCodes,
      'Should have PROCESS_STOP_TIMEOUT',
    )
    assert('PID_FILE_CORRUPT' in ErrorCodes, 'Should have PID_FILE_CORRUPT')
    assert('PID_FILE_STALE' in ErrorCodes, 'Should have PID_FILE_STALE')

    // Restore errors
    assert('VERSION_MISMATCH' in ErrorCodes, 'Should have VERSION_MISMATCH')
    assert(
      'RESTORE_PARTIAL_FAILURE' in ErrorCodes,
      'Should have RESTORE_PARTIAL_FAILURE',
    )

    // Container errors
    assert(
      'CONTAINER_NOT_FOUND' in ErrorCodes,
      'Should have CONTAINER_NOT_FOUND',
    )
    assert(
      'CONTAINER_ALREADY_EXISTS' in ErrorCodes,
      'Should have CONTAINER_ALREADY_EXISTS',
    )

    // Dependency errors
    assert('DEPENDENCY_MISSING' in ErrorCodes, 'Should have DEPENDENCY_MISSING')

    // Rollback errors
    assert('ROLLBACK_FAILED' in ErrorCodes, 'Should have ROLLBACK_FAILED')
  })
})
