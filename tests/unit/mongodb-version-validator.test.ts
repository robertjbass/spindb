import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVersion,
  compareVersions,
  isVersionCompatible,
  getMajorMinorVersion,
  isValidVersionFormat,
} from '../../engines/mongodb/version-validator'

// =============================================================================
// parseVersion Tests
// =============================================================================

describe('MongoDB parseVersion', () => {
  describe('standard version strings', () => {
    it('should parse full three-part version', () => {
      const result = parseVersion('8.0.4')
      assert.notEqual(result, null)
      assert.equal(result?.major, 8)
      assert.equal(result?.minor, 0)
      assert.equal(result?.patch, 4)
      assert.equal(result?.raw, '8.0.4')
    })

    it('should parse two-part version', () => {
      const result = parseVersion('8.0')
      assert.notEqual(result, null)
      assert.equal(result?.major, 8)
      assert.equal(result?.minor, 0)
      assert.equal(result?.patch, 0)
    })

    it('should parse MongoDB 7.x version', () => {
      const result = parseVersion('7.0.12')
      assert.notEqual(result, null)
      assert.equal(result?.major, 7)
      assert.equal(result?.minor, 0)
      assert.equal(result?.patch, 12)
    })
  })

  describe('version with prefix', () => {
    it('should handle version with lowercase "v" prefix', () => {
      const result = parseVersion('v8.0.4')
      assert.notEqual(result, null)
      assert.equal(result?.major, 8)
      assert.equal(result?.minor, 0)
    })

    it('should handle version with whitespace', () => {
      const result = parseVersion('  8.0.4  ')
      assert.notEqual(result, null)
      assert.equal(result?.major, 8)
      assert.equal(result?.minor, 0)
    })
  })

  describe('error handling', () => {
    it('should return null for single number', () => {
      const result = parseVersion('8')
      assert.equal(result, null)
    })

    it('should return null for empty string', () => {
      const result = parseVersion('')
      assert.equal(result, null)
    })

    it('should return null for non-numeric version', () => {
      const result = parseVersion('abc.def')
      assert.equal(result, null)
    })
  })
})

// =============================================================================
// compareVersions Tests
// =============================================================================

describe('MongoDB compareVersions', () => {
  it('should return 0 for equal versions', () => {
    assert.equal(compareVersions('8.0.4', '8.0.4'), 0)
  })

  it('should return -1 when first is older (major)', () => {
    assert.equal(compareVersions('7.0.0', '8.0.0'), -1)
  })

  it('should return 1 when first is newer (major)', () => {
    assert.equal(compareVersions('8.0.0', '7.0.0'), 1)
  })

  it('should return -1 when first is older (minor)', () => {
    assert.equal(compareVersions('8.0.0', '8.1.0'), -1)
  })

  it('should return 1 when first is newer (minor)', () => {
    assert.equal(compareVersions('8.2.0', '8.1.0'), 1)
  })

  it('should return -1 when first is older (patch)', () => {
    assert.equal(compareVersions('8.0.3', '8.0.4'), -1)
  })

  it('should return 1 when first is newer (patch)', () => {
    assert.equal(compareVersions('8.0.4', '8.0.3'), 1)
  })

  it('should return null for invalid versions', () => {
    assert.equal(compareVersions('invalid', '8.0.4'), null)
    assert.equal(compareVersions('8.0.4', 'invalid'), null)
  })
})

// =============================================================================
// isVersionCompatible Tests
// =============================================================================

describe('MongoDB isVersionCompatible', () => {
  describe('compatible scenarios', () => {
    it('should be compatible for same version', () => {
      const result = isVersionCompatible('8.0.4', '8.0.4')
      assert.equal(result.compatible, true)
      assert.equal(result.warning, undefined)
    })

    it('should be compatible for same major version', () => {
      const result = isVersionCompatible('8.0.2', '8.0.4')
      assert.equal(result.compatible, true)
      assert.equal(result.warning, undefined)
    })

    it('should be compatible for one major version upgrade', () => {
      const result = isVersionCompatible('7.0.12', '8.0.4')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('upgrade'))
    })
  })

  describe('incompatible scenarios', () => {
    it('should be incompatible when restoring newer to older major version', () => {
      const result = isVersionCompatible('8.0.4', '7.0.12')
      assert.equal(result.compatible, false)
      assert.ok(result.warning?.includes('newer major'))
    })

    it('should be incompatible for more than one major version difference', () => {
      const result = isVersionCompatible('6.0.0', '8.0.4')
      assert.equal(result.compatible, false)
      assert.ok(result.warning?.includes('too large'))
    })
  })

  describe('edge cases', () => {
    it('should be compatible when versions cannot be parsed', () => {
      const result = isVersionCompatible('invalid', '8.0.4')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('Could not parse'))
    })
  })
})

// =============================================================================
// getMajorMinorVersion Tests
// =============================================================================

describe('MongoDB getMajorMinorVersion', () => {
  it('should extract major.minor from full version', () => {
    assert.equal(getMajorMinorVersion('8.0.4'), '8.0')
  })

  it('should handle two-part version', () => {
    assert.equal(getMajorMinorVersion('8.0'), '8.0')
  })

  it('should return original for invalid version', () => {
    assert.equal(getMajorMinorVersion('invalid'), 'invalid')
  })
})

// =============================================================================
// isValidVersionFormat Tests
// =============================================================================

describe('MongoDB isValidVersionFormat', () => {
  it('should return true for valid three-part version', () => {
    assert.equal(isValidVersionFormat('8.0.4'), true)
  })

  it('should return true for valid two-part version', () => {
    assert.equal(isValidVersionFormat('8.0'), true)
  })

  it('should return false for single number', () => {
    assert.equal(isValidVersionFormat('8'), false)
  })

  it('should return false for empty string', () => {
    assert.equal(isValidVersionFormat(''), false)
  })
})
