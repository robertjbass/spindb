import { describe, it } from 'node:test'
import { BinaryManager } from '../../core/binary-manager'
import { assert, assertEqual } from '../utils/assertions'

describe('BinaryManager', () => {
  describe('getFullVersion', () => {
    it('should map major versions to full versions', () => {
      const binaryManager = new BinaryManager()

      const testCases = [
        { input: '14', expected: '14.20.0' },
        { input: '15', expected: '15.15.0' },
        { input: '16', expected: '16.11.0' },
        { input: '17', expected: '17.7.0' },
        { input: '18', expected: '18.1.0' },
      ]

      for (const { input, expected } of testCases) {
        const result = binaryManager.getFullVersion(input)
        assertEqual(
          result,
          expected,
          `Major version ${input} should map to ${expected}`,
        )
      }
    })

    it('should normalize two-part versions to three parts', () => {
      const binaryManager = new BinaryManager()

      assertEqual(
        binaryManager.getFullVersion('16.9'),
        '16.9.0',
        'Should add .0 to two-part versions',
      )
      assertEqual(
        binaryManager.getFullVersion('15.4'),
        '15.4.0',
        'Should add .0 to two-part versions',
      )
    })

    it('should return three-part versions unchanged', () => {
      const binaryManager = new BinaryManager()

      assertEqual(
        binaryManager.getFullVersion('16.9.0'),
        '16.9.0',
        'Should not modify three-part versions',
      )
      assertEqual(
        binaryManager.getFullVersion('17.7.0'),
        '17.7.0',
        'Should not modify three-part versions',
      )
    })
  })

  describe('getDownloadUrl', () => {
    it('should generate valid hostdb GitHub releases URL for darwin-arm64', () => {
      const binaryManager = new BinaryManager()
      const url = binaryManager.getDownloadUrl('17', 'darwin', 'arm64')

      assert(
        url.includes('github.com/robertjbass/hostdb'),
        'URL should use hostdb GitHub',
      )
      assert(
        url.includes('releases/download'),
        'URL should reference GitHub releases',
      )
      assert(
        url.includes('darwin-arm64'),
        'URL should include platform identifier for ARM Mac',
      )
      assert(url.endsWith('.tar.gz'), 'URL should point to tar.gz file')
    })

    it('should generate valid URL for darwin-x64', () => {
      const binaryManager = new BinaryManager()
      const url = binaryManager.getDownloadUrl('16', 'darwin', 'x64')

      assert(
        url.includes('darwin-x64'),
        'URL should include platform identifier for Intel Mac',
      )
    })

    it('should generate valid URL for linux-x64', () => {
      const binaryManager = new BinaryManager()
      const url = binaryManager.getDownloadUrl('16', 'linux', 'x64')

      assert(
        url.includes('linux-x64'),
        'URL should include platform identifier for Linux x64',
      )
    })

    it('should return EDB URL for Windows platform', () => {
      const binaryManager = new BinaryManager()
      const url = binaryManager.getDownloadUrl('17', 'win32', 'x64')

      assert(
        url.includes('sbp.enterprisedb.com'),
        'Windows URL should use EDB domain',
      )
      assert(url.includes('fileid='), 'Windows URL should include file ID')
    })

    it('should throw error for unsupported platform', () => {
      const binaryManager = new BinaryManager()

      try {
        binaryManager.getDownloadUrl('17', 'freebsd', 'x64')
        assert(false, 'Should have thrown an error')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          error.message.includes('Unsupported platform'),
          `Error should mention unsupported platform: ${error.message}`,
        )
        assert(
          error.message.includes('freebsd-x64'),
          `Error should include the platform key: ${error.message}`,
        )
      }
    })

    it('should include full version in URL', () => {
      const binaryManager = new BinaryManager()
      const url = binaryManager.getDownloadUrl('17', 'darwin', 'arm64')

      // Major version 17 maps to 17.7.0
      assert(
        url.includes('17.7.0'),
        'URL should include full version (17.7.0), not just major version',
      )
    })
  })

  describe('getBinaryExecutable', () => {
    it('should return correct path for postgres binary', () => {
      const binaryManager = new BinaryManager()
      const path = binaryManager.getBinaryExecutable(
        '17',
        'darwin',
        'arm64',
        'postgres',
      )

      assert(
        path.includes('bin/postgres') || path.includes('bin\\postgres'),
        'Path should include bin/postgres',
      )
      assert(path.includes('17.7.0'), 'Path should use full version')
    })

    it('should return correct path for pg_ctl binary', () => {
      const binaryManager = new BinaryManager()
      const path = binaryManager.getBinaryExecutable(
        '16',
        'darwin',
        'arm64',
        'pg_ctl',
      )

      assert(
        path.includes('bin/pg_ctl') || path.includes('bin\\pg_ctl'),
        'Path should include bin/pg_ctl',
      )
    })

    it('should return correct path for initdb binary', () => {
      const binaryManager = new BinaryManager()
      const path = binaryManager.getBinaryExecutable(
        '16',
        'darwin',
        'arm64',
        'initdb',
      )

      assert(
        path.includes('bin/initdb') || path.includes('bin\\initdb'),
        'Path should include bin/initdb',
      )
    })
  })

  describe('listInstalled', () => {
    it('should return array of InstalledBinary objects', async () => {
      const binaryManager = new BinaryManager()
      const installed = await binaryManager.listInstalled()

      assert(Array.isArray(installed), 'Should return an array')

      for (const binary of installed) {
        assert(typeof binary.engine === 'string', 'Should have engine')
        assert(typeof binary.version === 'string', 'Should have version')
        assert(typeof binary.platform === 'string', 'Should have platform')
        assert(typeof binary.arch === 'string', 'Should have arch')
      }
    })
  })

  describe('isInstalled', () => {
    it('should return boolean', async () => {
      const binaryManager = new BinaryManager()
      const result = await binaryManager.isInstalled('99', 'darwin', 'arm64')

      assert(typeof result === 'boolean', 'Should return boolean')
      // Version 99 shouldn't exist
      assertEqual(result, false, 'Non-existent version should not be installed')
    })

    it('should use full version for path checking', async () => {
      const binaryManager = new BinaryManager()
      // This tests that isInstalled internally calls getFullVersion
      const result = await binaryManager.isInstalled('17', 'darwin', 'arm64')

      assert(typeof result === 'boolean', 'Should handle major version input')
    })
  })

  describe('verify', () => {
    it('should throw error for non-existent binary', async () => {
      const binaryManager = new BinaryManager()

      try {
        await binaryManager.verify('99', 'darwin', 'arm64')
        assert(false, 'Should have thrown an error')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          error.message.includes('not found'),
          `Error should indicate binary not found: ${error.message}`,
        )
      }
    })

    it('should parse postgres --version output correctly', () => {
      const testOutputs = [
        { output: 'postgres (PostgreSQL) 16.9', expected: '16.9' },
        { output: 'postgres (PostgreSQL) 17.7', expected: '17.7' },
        { output: 'postgres (PostgreSQL) 15.4', expected: '15.4' },
      ]

      for (const { output, expected } of testOutputs) {
        const match = output.match(/postgres \(PostgreSQL\) ([\d.]+)/)
        assert(match !== null, `Should match pattern in: ${output}`)
        assertEqual(match![1], expected, `Should extract version ${expected}`)
      }
    })
  })

  describe('ensureInstalled', () => {
    it('should invoke progress callback with cached stage when already installed', async () => {
      const binaryManager = new BinaryManager()
      const isInstalled = await binaryManager.isInstalled(
        '17',
        'darwin',
        'arm64',
      )

      if (isInstalled) {
        const progressCalls: Array<{ stage: string; message: string }> = []

        // Actually call ensureInstalled and verify the callback
        await binaryManager.ensureInstalled(
          '17',
          'darwin',
          'arm64',
          (progress) => {
            progressCalls.push(progress)
          },
        )

        assert(progressCalls.length > 0, 'Progress callback should be invoked')
        assertEqual(
          progressCalls[0].stage,
          'cached',
          'Should report cached stage',
        )
        assert(
          progressCalls[0].message.includes('cached'),
          'Message should mention cached',
        )
      }
    })

    it('should return path to binary directory', async () => {
      const binaryManager = new BinaryManager()
      const isInstalled = await binaryManager.isInstalled(
        '17',
        'darwin',
        'arm64',
      )

      if (isInstalled) {
        const binPath = await binaryManager.ensureInstalled(
          '17',
          'darwin',
          'arm64',
        )

        assert(typeof binPath === 'string', 'Should return path string')
        assert(binPath.includes('17.7.0'), 'Path should include full version')
        assert(binPath.includes('darwin-arm64'), 'Path should include platform')
      }
    })
  })

  describe('platform mappings via getDownloadUrl', () => {
    it('should use correct hostdb platform identifiers in URLs', () => {
      const binaryManager = new BinaryManager()

      // Test darwin-arm64 uses standard naming
      const armUrl = binaryManager.getDownloadUrl('17', 'darwin', 'arm64')
      assert(
        armUrl.includes('darwin-arm64'),
        'ARM Mac should use darwin-arm64',
      )

      // Test darwin-x64 uses standard naming
      const intelUrl = binaryManager.getDownloadUrl('17', 'darwin', 'x64')
      assert(
        intelUrl.includes('darwin-x64'),
        'Intel Mac should use darwin-x64',
      )

      // Test linux-x64 uses standard naming
      const linuxUrl = binaryManager.getDownloadUrl('17', 'linux', 'x64')
      assert(linuxUrl.includes('linux-x64'), 'Linux x64 should use linux-x64')
    })
  })
})
