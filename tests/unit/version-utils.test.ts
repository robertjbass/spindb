import { describe, it } from 'node:test'
import {
  isShorthandVersion,
  parsePrereleaseVersion,
  isPrereleaseVersion,
  prereleaseVersionMatches,
  compareVersions,
} from '../../core/version-utils'
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
      assert(
        isShorthandVersion('25.12') === true,
        "'25.12' should be shorthand",
      )
    })

    it('3-part is full', () => {
      assert(
        isShorthandVersion('17.10.0') === false,
        "'17.10.0' should be full",
      )
      assert(isShorthandVersion('11.8.6') === false, "'11.8.6' should be full")
      assert(isShorthandVersion('8.0.23') === false, "'8.0.23' should be full")
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

describe('parsePrereleaseVersion', () => {
  it('parses hostdb canonical form', () => {
    const parsed = parsePrereleaseVersion('19.0.0-beta.1')
    assert(parsed !== null, 'should parse canonical form')
    assert(parsed?.major === 19, 'major should be 19')
    assert(parsed?.type === 'beta', 'type should be beta')
    assert(parsed?.num === 1, 'num should be 1')
  })

  it('parses upstream self-reported form', () => {
    const parsed = parsePrereleaseVersion('19beta1')
    assert(parsed !== null, 'should parse reported form')
    assert(parsed?.major === 19, 'major should be 19')
    assert(parsed?.type === 'beta', 'type should be beta')
    assert(parsed?.num === 1, 'num should be 1')
  })

  it('parses rc and alpha channels', () => {
    assert(
      parsePrereleaseVersion('17.0.0-rc.2')?.type === 'rc',
      'rc channel parsed',
    )
    assert(
      parsePrereleaseVersion('17alpha3')?.type === 'alpha',
      'alpha channel parsed',
    )
  })

  it('returns null for GA versions', () => {
    assert(parsePrereleaseVersion('18.4.0') === null, 'GA is not a prerelease')
    assert(parsePrereleaseVersion('19') === null, 'bare major is not prerelease')
    assert(parsePrereleaseVersion('') === null, 'empty string is not prerelease')
  })
})

describe('isPrereleaseVersion', () => {
  it('is true for prerelease forms', () => {
    assert(isPrereleaseVersion('19.0.0-beta.1') === true, 'canonical beta')
    assert(isPrereleaseVersion('19beta1') === true, 'reported beta')
  })

  it('is false for GA', () => {
    assert(isPrereleaseVersion('18.4.0') === false, 'GA release')
  })
})

describe('prereleaseVersionMatches', () => {
  it('matches canonical expected against self-reported', () => {
    assert(
      prereleaseVersionMatches('19.0.0-beta.1', '19beta1') === true,
      'expected 19.0.0-beta.1 should accept reported 19beta1',
    )
  })

  it('does not match a different channel or number', () => {
    assert(
      prereleaseVersionMatches('19.0.0-beta.1', '19beta2') === false,
      'different prerelease number should not match',
    )
    assert(
      prereleaseVersionMatches('19.0.0-beta.1', '19rc1') === false,
      'different channel should not match',
    )
  })

  it('never matches when either side is GA (does not loosen GA verify)', () => {
    assert(
      prereleaseVersionMatches('19.0.0', '19') === false,
      'GA expected should not match via prerelease path',
    )
    assert(
      prereleaseVersionMatches('19.0.0-beta.1', '19') === false,
      'GA reported should not match a prerelease expectation',
    )
  })
})

describe('compareVersions prerelease ordering', () => {
  it('sorts a prerelease below its GA release', () => {
    assert(
      compareVersions('19.0.0', '19.0.0-beta.2') > 0,
      'GA should be greater than beta of same version',
    )
    assert(
      compareVersions('19.0.0-beta.2', '19.0.0') < 0,
      'beta should be less than GA of same version',
    )
  })

  it('descending sort places GA first, then prereleases newest-first', () => {
    const sorted = ['19.0.0-beta.1', '19.0.0', '18.4.0'].sort((a, b) =>
      compareVersions(b, a),
    )
    assert(sorted[0] === '19.0.0', 'GA 19.0.0 should sort first')
    assert(sorted[1] === '19.0.0-beta.1', 'beta should follow its GA')
    assert(sorted[2] === '18.4.0', 'older GA last')
  })
})
