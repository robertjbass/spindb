import { describe, it, before, after } from 'node:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert } from '../utils/assertions'

/**
 * Test the binary extraction logic for cross-platform compatibility.
 *
 * These tests verify that the moveExtractedEntries logic correctly handles
 * different archive structures:
 * - Unix: redis/bin/redis-server (has bin/ subdirectory)
 * - Windows: redis/redis-server.exe (no bin/ subdirectory, binaries at root)
 *
 * The extraction should normalize both to binPath/bin/ structure.
 */

let testDir: string

describe('Redis Binary Manager', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-redis-binary-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('archive structure detection', () => {
    it('should detect Unix structure (has bin/ subdirectory)', async () => {
      // Simulate Unix archive structure: redis/bin/redis-server
      const extractDir = join(testDir, 'unix-extract')
      const redisDir = join(extractDir, 'redis')
      const binDir = join(redisDir, 'bin')

      await mkdir(binDir, { recursive: true })
      await writeFile(join(binDir, 'redis-server'), 'fake-binary')
      await writeFile(join(binDir, 'redis-cli'), 'fake-binary')
      await writeFile(join(redisDir, 'redis.conf'), 'fake-config')

      // Check structure
      assert(
        existsSync(join(redisDir, 'bin')),
        'Unix structure should have bin/ directory',
      )
      assert(
        existsSync(join(binDir, 'redis-server')),
        'Unix structure should have redis-server in bin/',
      )
    })

    it('should detect Windows structure (no bin/ subdirectory)', async () => {
      // Simulate Windows archive structure: redis/redis-server.exe
      const extractDir = join(testDir, 'windows-extract')
      const redisDir = join(extractDir, 'redis')

      await mkdir(redisDir, { recursive: true })
      await writeFile(join(redisDir, 'redis-server.exe'), 'fake-binary')
      await writeFile(join(redisDir, 'redis-cli.exe'), 'fake-binary')
      await writeFile(join(redisDir, 'msys-2.0.dll'), 'fake-dll')
      await writeFile(join(redisDir, 'redis.conf'), 'fake-config')

      // Check structure - should NOT have bin/ directory
      assert(
        !existsSync(join(redisDir, 'bin')),
        'Windows structure should not have bin/ directory',
      )
      assert(
        existsSync(join(redisDir, 'redis-server.exe')),
        'Windows structure should have redis-server.exe at root',
      )
    })
  })

  describe('moveExtractedEntries logic', () => {
    /**
     * Re-implement the core logic from binary-manager.ts for testing.
     * This tests the algorithm without needing to mock the actual file operations.
     */

    interface FileEntry {
      name: string
      isDirectory: boolean
    }

    function simulateMoveExtractedEntries(sourceEntries: FileEntry[]): {
      hasBinDir: boolean
      destinationMap: Map<string, string>
    } {
      const hasBinDir = sourceEntries.some(
        (e) => e.isDirectory && e.name === 'bin',
      )

      const destinationMap = new Map<string, string>()

      if (hasBinDir) {
        // Unix structure: move all entries as-is
        for (const entry of sourceEntries) {
          destinationMap.set(entry.name, entry.name)
        }
      } else {
        // Windows structure: create bin/ and move executables/DLLs there
        for (const entry of sourceEntries) {
          const isExecutable = entry.name.endsWith('.exe')
          const isDll = entry.name.endsWith('.dll')
          const destPath =
            isExecutable || isDll ? `bin/${entry.name}` : entry.name
          destinationMap.set(entry.name, destPath)
        }
      }

      return { hasBinDir, destinationMap }
    }

    it('should preserve bin/ structure for Unix archives', () => {
      const unixEntries: FileEntry[] = [
        { name: 'bin', isDirectory: true },
        { name: 'redis.conf', isDirectory: false },
        { name: 'sentinel.conf', isDirectory: false },
      ]

      const result = simulateMoveExtractedEntries(unixEntries)

      assert(result.hasBinDir, 'Should detect bin/ directory')
      assert(
        result.destinationMap.get('bin') === 'bin',
        'bin/ should be preserved as-is',
      )
      assert(
        result.destinationMap.get('redis.conf') === 'redis.conf',
        'Config files should be preserved at root',
      )
    })

    it('should create bin/ structure for Windows archives', () => {
      const windowsEntries: FileEntry[] = [
        { name: 'redis-server.exe', isDirectory: false },
        { name: 'redis-cli.exe', isDirectory: false },
        { name: 'redis-benchmark.exe', isDirectory: false },
        { name: 'msys-2.0.dll', isDirectory: false },
        { name: 'msys-ssl-3.dll', isDirectory: false },
        { name: 'redis.conf', isDirectory: false },
        { name: 'sentinel.conf', isDirectory: false },
        { name: 'README.md', isDirectory: false },
      ]

      const result = simulateMoveExtractedEntries(windowsEntries)

      assert(!result.hasBinDir, 'Should not detect bin/ directory')

      // Executables should go to bin/
      assert(
        result.destinationMap.get('redis-server.exe') ===
          'bin/redis-server.exe',
        'redis-server.exe should move to bin/',
      )
      assert(
        result.destinationMap.get('redis-cli.exe') === 'bin/redis-cli.exe',
        'redis-cli.exe should move to bin/',
      )

      // DLLs should go to bin/ (same directory as executables)
      assert(
        result.destinationMap.get('msys-2.0.dll') === 'bin/msys-2.0.dll',
        'DLLs should move to bin/ with executables',
      )
      assert(
        result.destinationMap.get('msys-ssl-3.dll') === 'bin/msys-ssl-3.dll',
        'DLLs should move to bin/ with executables',
      )

      // Config files should stay at root
      assert(
        result.destinationMap.get('redis.conf') === 'redis.conf',
        'Config files should stay at root',
      )
      assert(
        result.destinationMap.get('README.md') === 'README.md',
        'README should stay at root',
      )
    })

    it('should handle empty archives gracefully', () => {
      const emptyEntries: FileEntry[] = []
      const result = simulateMoveExtractedEntries(emptyEntries)

      assert(!result.hasBinDir, 'Empty archive should not have bin/')
      assert(result.destinationMap.size === 0, 'No files to map')
    })

    it('should handle archives with only config files', () => {
      const configOnlyEntries: FileEntry[] = [
        { name: 'redis.conf', isDirectory: false },
        { name: 'sentinel.conf', isDirectory: false },
      ]

      const result = simulateMoveExtractedEntries(configOnlyEntries)

      assert(!result.hasBinDir, 'Should not detect bin/')
      assert(
        result.destinationMap.get('redis.conf') === 'redis.conf',
        'Config should stay at root',
      )
    })
  })
})
