import { describe, it } from 'node:test'
import { isVersionEnabled, isVersionDeprecated } from '../../core/hostdb-metadata'
import { assertEqual } from '../utils/assertions'

describe('isVersionEnabled', () => {
  it('should return true for boolean true', () => {
    assertEqual(isVersionEnabled(true), true, 'true should be enabled')
  })

  it('should return false for boolean false', () => {
    assertEqual(isVersionEnabled(false), false, 'false should be disabled')
  })

  it('should return true for empty object (enabled by default)', () => {
    assertEqual(isVersionEnabled({}), true, 'empty object should be enabled')
  })

  it('should return true for object with enabled: true', () => {
    assertEqual(
      isVersionEnabled({ enabled: true }),
      true,
      'explicitly enabled should be true',
    )
  })

  it('should return false for object with enabled: false', () => {
    assertEqual(
      isVersionEnabled({ enabled: false }),
      false,
      'explicitly disabled should be false',
    )
  })

  it('should return true for object with platforms only', () => {
    assertEqual(
      isVersionEnabled({ platforms: ['darwin-arm64'] }),
      true,
      'object with platforms but no enabled field should be enabled',
    )
  })

  it('should return true for object with dependencies', () => {
    assertEqual(
      isVersionEnabled({
        dependencies: [
          { database: 'postgresql', cascadeDelete: true, note: 'required' },
        ],
      }),
      true,
      'object with dependencies but no enabled field should be enabled',
    )
  })

  it('should return true for deprecated version (still enabled)', () => {
    assertEqual(
      isVersionEnabled({ deprecated: true }),
      true,
      'deprecated version should still be enabled',
    )
  })
})

describe('isVersionDeprecated', () => {
  it('should return false for boolean true', () => {
    assertEqual(isVersionDeprecated(true), false, 'boolean true is not deprecated')
  })

  it('should return false for boolean false', () => {
    assertEqual(isVersionDeprecated(false), false, 'boolean false is not deprecated')
  })

  it('should return false for empty object', () => {
    assertEqual(isVersionDeprecated({}), false, 'empty object is not deprecated')
  })

  it('should return true for object with deprecated: true', () => {
    assertEqual(
      isVersionDeprecated({ deprecated: true }),
      true,
      'explicitly deprecated should be true',
    )
  })

  it('should return false for object with deprecated: false', () => {
    assertEqual(
      isVersionDeprecated({ deprecated: false }),
      false,
      'explicitly not deprecated should be false',
    )
  })

  it('should return true for deprecated version with note', () => {
    assertEqual(
      isVersionDeprecated({ deprecated: true, note: 'Use 9.6.0 instead' }),
      true,
      'deprecated with note should be true',
    )
  })

  it('should return false for object with only platforms', () => {
    assertEqual(
      isVersionDeprecated({ platforms: ['linux-x64'] }),
      false,
      'object with only platforms is not deprecated',
    )
  })
})
