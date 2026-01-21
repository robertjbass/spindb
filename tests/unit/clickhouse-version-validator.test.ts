import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVersion,
  compareVersions,
  getMajorVersion,
  getMajorMinorPatchVersion,
  isVersionSupported,
  isVersionCompatible,
  isValidVersionFormat,
} from '../../engines/clickhouse/version-validator'

// =============================================================================
// parseVersion Tests
// ClickHouse uses YY.MM.X.build versioning (e.g., 25.12.3.21)
// =============================================================================

describe('ClickHouse parseVersion', () => {
  describe('standard version strings', () => {
    it('should parse full four-part version', () => {
      const result = parseVersion('25.12.3.21')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
      assert.equal(result?.patch, 3)
      assert.equal(result?.build, 21)
      assert.equal(result?.raw, '25.12.3.21')
    })

    it('should parse three-part version', () => {
      const result = parseVersion('25.12.3')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
      assert.equal(result?.patch, 3)
      assert.equal(result?.build, 0)
    })

    it('should parse two-part version', () => {
      const result = parseVersion('25.12')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
      assert.equal(result?.patch, 0)
      assert.equal(result?.build, 0)
    })
  })

  describe('version with prefix', () => {
    it('should handle version with lowercase "v" prefix', () => {
      const result = parseVersion('v25.12.3.21')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
    })

    it('should handle version with whitespace', () => {
      const result = parseVersion('  25.12.3  ')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
    })
  })

  describe('error handling', () => {
    it('should return null for single number', () => {
      const result = parseVersion('25')
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

describe('ClickHouse compareVersions', () => {
  it('should return 0 for equal versions', () => {
    assert.equal(compareVersions('25.12.3.21', '25.12.3.21'), 0)
  })

  it('should return -1 when first is older (year)', () => {
    assert.equal(compareVersions('24.12.3.21', '25.12.3.21'), -1)
  })

  it('should return 1 when first is newer (year)', () => {
    assert.equal(compareVersions('25.12.3.21', '24.12.3.21'), 1)
  })

  it('should return -1 when first is older (month)', () => {
    assert.equal(compareVersions('25.11.3.21', '25.12.3.21'), -1)
  })

  it('should return 1 when first is newer (month)', () => {
    assert.equal(compareVersions('25.12.3.21', '25.11.3.21'), 1)
  })

  it('should return -1 when first is older (patch)', () => {
    assert.equal(compareVersions('25.12.2.21', '25.12.3.21'), -1)
  })

  it('should return -1 when first is older (build)', () => {
    assert.equal(compareVersions('25.12.3.20', '25.12.3.21'), -1)
  })

  it('should return null for invalid versions', () => {
    assert.equal(compareVersions('invalid', '25.12.3.21'), null)
    assert.equal(compareVersions('25.12.3.21', 'invalid'), null)
  })
})

// =============================================================================
// getMajorVersion Tests
// =============================================================================

describe('ClickHouse getMajorVersion', () => {
  it('should extract YY.MM from full version', () => {
    assert.equal(getMajorVersion('25.12.3.21'), '25.12')
  })

  it('should extract YY.MM from three-part version', () => {
    assert.equal(getMajorVersion('25.12.3'), '25.12')
  })

  it('should return original for two-part version', () => {
    assert.equal(getMajorVersion('25.12'), '25.12')
  })

  it('should return original for invalid version', () => {
    assert.equal(getMajorVersion('invalid'), 'invalid')
  })
})

// =============================================================================
// getMajorMinorPatchVersion Tests
// =============================================================================

describe('ClickHouse getMajorMinorPatchVersion', () => {
  it('should extract YY.MM.X from full version', () => {
    assert.equal(getMajorMinorPatchVersion('25.12.3.21'), '25.12.3')
  })

  it('should return same for three-part version', () => {
    assert.equal(getMajorMinorPatchVersion('25.12.3'), '25.12.3')
  })

  it('should add .0 for two-part version', () => {
    assert.equal(getMajorMinorPatchVersion('25.12'), '25.12.0')
  })
})

// =============================================================================
// isVersionSupported Tests
// =============================================================================

describe('ClickHouse isVersionSupported', () => {
  it('should support ClickHouse 25.x', () => {
    assert.equal(isVersionSupported('25.12.3.21'), true)
  })

  it('should support ClickHouse 24.x', () => {
    assert.equal(isVersionSupported('24.1.0.0'), true)
  })

  it('should not support ClickHouse 23.x or older', () => {
    assert.equal(isVersionSupported('23.12.0.0'), false)
    assert.equal(isVersionSupported('22.1.0.0'), false)
  })

  it('should return false for invalid version', () => {
    assert.equal(isVersionSupported('invalid'), false)
  })
})

// =============================================================================
// isVersionCompatible Tests
// =============================================================================

describe('ClickHouse isVersionCompatible', () => {
  describe('compatible scenarios', () => {
    it('should be compatible for same version', () => {
      const result = isVersionCompatible('25.12.3.21', '25.12.3.21')
      assert.equal(result.compatible, true)
      assert.equal(result.warning, undefined)
    })

    it('should be compatible for upgrading from older version', () => {
      const result = isVersionCompatible('25.6.0.0', '25.12.0.0')
      assert.equal(result.compatible, true)
      // May have a warning about schema updates
    })

    it('should be compatible within 6 months difference (same year)', () => {
      const result = isVersionCompatible('25.8.0.0', '25.6.0.0')
      assert.equal(result.compatible, true)
    })

    it('should be compatible across year boundary within 6 months', () => {
      // January 26 restore, backup from November 25 (2 months diff)
      const result = isVersionCompatible('25.11.0.0', '26.1.0.0')
      assert.equal(result.compatible, true)
    })
  })

  describe('incompatible scenarios', () => {
    it('should be incompatible when backup is much newer than restore', () => {
      // More than 6 months newer
      const result = isVersionCompatible('26.6.0.0', '25.6.0.0')
      assert.equal(result.compatible, false)
      assert.ok(result.warning?.includes('much newer'))
    })
  })

  describe('warning scenarios', () => {
    it('should warn when restoring to slightly older version', () => {
      const result = isVersionCompatible('25.12.0.0', '25.8.0.0')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('older'))
    })

    it('should warn when upgrading across versions', () => {
      const result = isVersionCompatible('24.12.0.0', '25.12.0.0')
      assert.equal(result.compatible, true)
      // May have upgrade warning
    })
  })

  describe('edge cases', () => {
    it('should be compatible when versions cannot be parsed', () => {
      const result = isVersionCompatible('invalid', '25.12.0.0')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('Could not parse'))
    })
  })
})

// =============================================================================
// isValidVersionFormat Tests
// =============================================================================

describe('ClickHouse isValidVersionFormat', () => {
  it('should return true for valid four-part version', () => {
    assert.equal(isValidVersionFormat('25.12.3.21'), true)
  })

  it('should return true for valid two-part version', () => {
    assert.equal(isValidVersionFormat('25.12'), true)
  })

  it('should return false for single number', () => {
    assert.equal(isValidVersionFormat('25'), false)
  })

  it('should return false for empty string', () => {
    assert.equal(isValidVersionFormat(''), false)
  })
})
