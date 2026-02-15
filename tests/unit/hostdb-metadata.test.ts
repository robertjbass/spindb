import { describe, it } from 'node:test'
import { isVersionEnabled } from '../../core/hostdb-metadata'
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
})
