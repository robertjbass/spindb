/**
 * Shared test assertion utilities
 * Used by both unit and integration tests
 */

// Assert helper that throws with descriptive message
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

// Assert two values are equal
export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\n  Expected: ${expected}\n  Actual: ${actual}`)
  }
}

// Assert two values are not equal
export function assertNotEqual<T>(
  actual: T,
  notExpected: T,
  message: string,
): void {
  if (actual === notExpected) {
    throw new Error(`${message}\n  Should not be: ${notExpected}\n  Actual: ${actual}`)
  }
}

// Assert a value is truthy
export function assertTruthy<T>(
  value: T,
  message: string,
): asserts value is NonNullable<T> {
  if (!value) {
    throw new Error(`${message}\n  Expected truthy value, got: ${value}`)
  }
}

// Assert a value is null or undefined
export function assertNullish(
  value: unknown,
  message: string,
): asserts value is null | undefined {
  if (value != null) {
    throw new Error(`${message}\n  Expected null/undefined, got: ${value}`)
  }
}
