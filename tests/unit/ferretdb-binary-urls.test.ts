/**
 * Unit tests for FerretDB binary URL generation
 *
 * Tests v1 vs v2 platform support and binary URL differences.
 */

import { describe, it } from 'node:test'
import { assertEqual, assert } from '../utils/assertions'
import {
  isPlatformSupported,
  getBinaryUrls,
  FERRETDB_V1_SUPPORTED_PLATFORMS,
  FERRETDB_V2_SUPPORTED_PLATFORMS,
} from '../../engines/ferretdb/binary-urls'
import { Arch, Platform } from '../../types'

describe('FerretDB Binary URLs', () => {
  describe('FERRETDB_V1_SUPPORTED_PLATFORMS', () => {
    it('should have 5 entries (includes Windows)', () => {
      assertEqual(
        FERRETDB_V1_SUPPORTED_PLATFORMS.size,
        5,
        'v1 should support 5 platforms',
      )
    })

    it('should include win32-x64', () => {
      assert(
        FERRETDB_V1_SUPPORTED_PLATFORMS.has('win32-x64'),
        'v1 should support Windows x64',
      )
    })
  })

  describe('FERRETDB_V2_SUPPORTED_PLATFORMS', () => {
    it('should have 4 entries (no Windows)', () => {
      assertEqual(
        FERRETDB_V2_SUPPORTED_PLATFORMS.size,
        4,
        'v2 should support 4 platforms',
      )
    })

    it('should not include win32-x64', () => {
      assert(
        !FERRETDB_V2_SUPPORTED_PLATFORMS.has('win32-x64'),
        'v2 should not support Windows x64',
      )
    })
  })

  describe('isPlatformSupported', () => {
    it('should return true for Windows x64 with v1', () => {
      assert(
        isPlatformSupported(Platform.Win32, Arch.X64, '1'),
        'Windows x64 should be supported for v1',
      )
    })

    it('should return false for Windows x64 with v2', () => {
      assert(
        !isPlatformSupported(Platform.Win32, Arch.X64, '2'),
        'Windows x64 should not be supported for v2',
      )
    })

    it('should return true for macOS arm64 with v1', () => {
      assert(
        isPlatformSupported(Platform.Darwin, Arch.ARM64, '1'),
        'macOS arm64 should be supported for v1',
      )
    })

    it('should return true for macOS arm64 with v2', () => {
      assert(
        isPlatformSupported(Platform.Darwin, Arch.ARM64, '2'),
        'macOS arm64 should be supported for v2',
      )
    })

    it('should return true for Linux x64 with v1', () => {
      assert(
        isPlatformSupported(Platform.Linux, Arch.X64, '1'),
        'Linux x64 should be supported for v1',
      )
    })

    it('should return true for full v1 version string', () => {
      assert(
        isPlatformSupported(Platform.Win32, Arch.X64, '1.24.2'),
        'Windows x64 should be supported for v1 full version',
      )
    })
  })

  describe('getBinaryUrls', () => {
    it('should return only ferretdb URL for v1', () => {
      const urls = getBinaryUrls('1', '17-0.107.0', Platform.Darwin, Arch.ARM64)
      assert(urls.ferretdb !== undefined, 'Should have ferretdb URL')
      assert(urls.documentdb === undefined, 'v1 should not have documentdb URL')
    })

    it('should return both ferretdb and documentdb URLs for v2', () => {
      const urls = getBinaryUrls('2', '17-0.107.0', Platform.Darwin, Arch.ARM64)
      assert(urls.ferretdb !== undefined, 'Should have ferretdb URL')
      assert(urls.documentdb !== undefined, 'v2 should have documentdb URL')
    })

    it('v1 and v2 URLs should use ferretdb engine with version-specific paths', () => {
      const v1Urls = getBinaryUrls(
        '1',
        '17-0.107.0',
        Platform.Darwin,
        Arch.ARM64,
      )
      const v2Urls = getBinaryUrls(
        '2',
        '17-0.107.0',
        Platform.Darwin,
        Arch.ARM64,
      )
      assert(
        !v1Urls.ferretdb.includes('ferretdb-v1-'),
        'v1 URL should not contain ferretdb-v1 engine name',
      )
      assert(
        v1Urls.ferretdb.includes('/ferretdb-1.'),
        'v1 URL should use ferretdb engine with v1 version',
      )
      assert(
        v2Urls.ferretdb.includes('/ferretdb-2.'),
        'v2 URL should use ferretdb engine with v2 version',
      )
    })

    it('should throw for v2 on Windows', () => {
      let threw = false
      try {
        getBinaryUrls('2', '17-0.107.0', Platform.Win32, Arch.X64)
      } catch {
        threw = true
      }
      assert(threw, 'Should throw for v2 on Windows')
    })

    it('should not throw for v1 on Windows', () => {
      let threw = false
      try {
        getBinaryUrls('1', '17-0.107.0', Platform.Win32, Arch.X64)
      } catch {
        threw = true
      }
      assert(!threw, 'Should not throw for v1 on Windows')
    })
  })
})
