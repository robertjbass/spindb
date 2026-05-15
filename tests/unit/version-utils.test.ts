import { describe, it } from 'node:test'
import { isShorthandVersion } from '../../core/version-utils'
import { assert } from '../utils/assertions'

describe('isShorthandVersion', () => {
  describe('plain semver', () => {
    it('1-part is shorthand', () => {
      assert(isShorthandVersion('17') === true, "'17' should be shorthand")
      assert(isShorthandVersion('8') === true, "'8' should be shorthand")
      assert(isShorthandVersion('0') === true, "'0' should be shorthand")
    })

    it('2-part is shorthand', () => {
      assert(isShorthandVersion('8.4') === true, "'8.4' should be shorthand")
      assert(isShorthandVersion('11.8') === true, "'11.8' should be shorthand")
      assert(isShorthandVersion('25.12') === true, "'25.12' should be shorthand")
    })

    it('3-part is full', () => {
      assert(
        isShorthandVersion('17.10.0') === false,
        "'17.10.0' should be full",
      )
      assert(
        isShorthandVersion('11.8.6') === false,
        "'11.8.6' should be full",
      )
      assert(
        isShorthandVersion('8.0.23') === false,
        "'8.0.23' should be full",
      )
    })

    it('4-part ClickHouse is full', () => {
      assert(
        isShorthandVersion('25.12.3.21') === false,
        "'25.12.3.21' should be full (ClickHouse 4-part)",
      )
    })
  })

  describe('compound (postgresql-documentdb)', () => {
    it("compound full form is NOT shorthand (regression: '17-0.107.0')", () => {
      // Bug from the pre-merge audit: previous implementation returned true.
      assert(
        isShorthandVersion('17-0.107.0') === false,
        "'17-0.107.0' should be full — it's the pinned compound form",
      )
    })

    it('bare compound major (no suffix) IS shorthand', () => {
      // postgresql-documentdb's defaults block has '17' → '17-0.107.0'.
      // A container.version of '17' alone is shorthand and needs migration.
      assert(
        isShorthandVersion('17') === true,
        "'17' alone is shorthand even though it can resolve compound-side",
      )
    })

    it('dash with non-dotted suffix is still shorthand', () => {
      // Theoretical prerelease-like form. No patch component → shorthand.
      assert(
        isShorthandVersion('17-rc1') === true,
        "'17-rc1' should be shorthand (no patch)",
      )
    })
  })

  describe('sentinels and edge cases', () => {
    it('empty string is not shorthand', () => {
      assert(isShorthandVersion('') === false, "'' should not be flagged")
    })

    it("'unknown' is not shorthand (linked-remote sentinel)", () => {
      assert(
        isShorthandVersion('unknown') === false,
        "'unknown' should not be flagged — caller treats it specially",
      )
    })
  })
})
