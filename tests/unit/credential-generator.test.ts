/**
 * Conformance tests for the credential generator (core/credential-generator.ts).
 *
 * These assert the shared credential spec pinned in ADR-001
 * (layerbase-cloud/docs/decisions/001-credential-charsets.md). The same
 * spec is implemented and tested in layerbase-cloud (src/lib/credentials.ts +
 * its credentials conformance test); keeping equivalent assertions in both
 * repos is what stops the two security-sensitive generators from re-drifting.
 *
 * Spec:
 *   - generateCredentials() -> { username: 'spindb', password }
 *   - password is exactly DEFAULT_PASSWORD_LENGTH (24) characters
 *   - password is alphanumeric only ([A-Za-z0-9])
 *   - password contains none of the characters that are dangerous in SQL /
 *     shell / Redis-config / URL contexts (the safety invariant)
 *   - generatePassword honours the requested length and charset, and uses
 *     rejection sampling (no modulo bias) so every charset character is
 *     reachable
 */

import { describe, it } from 'node:test'
import {
  generateCredentials,
  generatePassword,
  DEFAULT_PASSWORD_LENGTH,
} from '../../core/credential-generator'
import { assert, assertEqual } from '../utils/assertions'

// The blocklist mirrors layerbase-cloud's assertSafeCredentials
// (DANGEROUS_CHARS_PATTERN). Anything matching this breaks at least one of:
// SQL single-quoted strings, shell single-quoted strings, Redis config values,
// or URL userinfo (without percent-encoding). The shared spec is alphanumeric,
// which trivially avoids all of them.
const DANGEROUS_CHARS = /['"`\\$#;@:/?&%!=|><~^ \t\n\r{}()[\]]/

const ALPHANUMERIC = /^[A-Za-z0-9]+$/

describe('credential generator (ADR-001 conformance)', () => {
  describe('generateCredentials', () => {
    it('uses the fixed username "spindb"', () => {
      assertEqual(generateCredentials().username, 'spindb', 'username')
    })

    it('produces a 24-character password', () => {
      assertEqual(DEFAULT_PASSWORD_LENGTH, 24, 'DEFAULT_PASSWORD_LENGTH')
      for (let i = 0; i < 50; i++) {
        assertEqual(
          generateCredentials().password.length,
          DEFAULT_PASSWORD_LENGTH,
          'password length',
        )
      }
    })

    it('produces an alphanumeric password with no dangerous characters', () => {
      for (let i = 0; i < 200; i++) {
        const { password } = generateCredentials()
        assert(
          ALPHANUMERIC.test(password),
          `password must be alphanumeric, got "${password}"`,
        )
        assert(
          !DANGEROUS_CHARS.test(password),
          `password must contain no dangerous characters, got "${password}"`,
        )
      }
    })

    it('produces a different password on each call', () => {
      const seen = new Set<string>()
      for (let i = 0; i < 100; i++) {
        seen.add(generateCredentials().password)
      }
      // 24 alphanumeric chars is ~143 bits of entropy; 100 draws colliding is
      // astronomically unlikely. Any collision means the generator is broken.
      assertEqual(seen.size, 100, 'unique passwords across 100 calls')
    })
  })

  describe('generatePassword', () => {
    it('honours the requested length', () => {
      for (const length of [1, 8, 16, 20, 24, 64, 128]) {
        assertEqual(
          generatePassword({ length }).length,
          length,
          `length ${length}`,
        )
      }
    })

    it('alphanumericOnly yields only [A-Za-z0-9]', () => {
      for (let i = 0; i < 100; i++) {
        const pw = generatePassword({ length: 32, alphanumericOnly: true })
        assert(ALPHANUMERIC.test(pw), `expected alphanumeric, got "${pw}"`)
      }
    })

    it('only emits characters from the requested custom charset', () => {
      const charset = 'abc123'
      const allowed = new RegExp(`^[${charset}]+$`)
      for (let i = 0; i < 100; i++) {
        const pw = generatePassword({ length: 40, charset })
        assert(allowed.test(pw), `expected only "${charset}", got "${pw}"`)
      }
    })

    it('rejection sampling reaches every character of the charset', () => {
      // With a charset length (62) that does not divide 256, a biased modulo
      // generator would still hit every char eventually, so this is a weak
      // smoke test that the generator is not stuck on a subset. Draw a large
      // alphanumeric sample and assert broad coverage.
      const charset =
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      const seen = new Set<string>()
      const sample = generatePassword({ length: 20000, charset })
      for (const ch of sample) seen.add(ch)
      assert(
        seen.size === charset.length,
        `expected all ${charset.length} charset chars to appear, saw ${seen.size}`,
      )
    })
  })
})
