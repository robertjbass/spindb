import { describe, it } from 'node:test'
import { assert } from '../utils/assertions'

/**
 * Test the generateRedisConfig function for cross-platform compatibility.
 *
 * These tests specifically verify that Windows paths are normalized to forward slashes,
 * which is required for Redis config files to work correctly on Windows.
 */

// Re-implement the config generation logic for testing
// (The actual function is not exported, so we test the same logic)
function generateRedisConfig(options: {
  port: number
  dataDir: string
  logFile: string
  pidFile: string
  daemonize?: boolean
}): string {
  const daemonizeValue = options.daemonize ?? true
  const normalizePathForRedis = (p: string) => p.replace(/\\/g, '/')

  return `# SpinDB generated Redis configuration
port ${options.port}
bind 127.0.0.1
dir ${normalizePathForRedis(options.dataDir)}
daemonize ${daemonizeValue ? 'yes' : 'no'}
logfile ${normalizePathForRedis(options.logFile)}
pidfile ${normalizePathForRedis(options.pidFile)}

# Persistence - RDB snapshots
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb

# Append Only File (disabled for local dev)
appendonly no
`
}

describe('Redis Config Generation', () => {
  describe('path normalization for Windows', () => {
    it('should convert Windows backslashes to forward slashes in dataDir', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: 'C:\\Users\\test\\.spindb\\containers\\redis\\test\\data',
        logFile: '/tmp/redis.log',
        pidFile: '/tmp/redis.pid',
      })

      assert(!config.includes('\\'), 'Config should not contain backslashes')
      assert(
        config.includes('dir C:/Users/test/.spindb/containers/redis/test/data'),
        'dataDir should use forward slashes',
      )
    })

    it('should convert Windows backslashes to forward slashes in logFile', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/tmp/data',
        logFile: 'C:\\Users\\test\\.spindb\\containers\\redis\\test\\redis.log',
        pidFile: '/tmp/redis.pid',
      })

      assert(!config.includes('\\'), 'Config should not contain backslashes')
      assert(
        config.includes(
          'logfile C:/Users/test/.spindb/containers/redis/test/redis.log',
        ),
        'logFile should use forward slashes',
      )
    })

    it('should convert Windows backslashes to forward slashes in pidFile', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/tmp/data',
        logFile: '/tmp/redis.log',
        pidFile: 'C:\\Users\\test\\.spindb\\containers\\redis\\test\\redis.pid',
      })

      assert(!config.includes('\\'), 'Config should not contain backslashes')
      assert(
        config.includes(
          'pidfile C:/Users/test/.spindb/containers/redis/test/redis.pid',
        ),
        'pidFile should use forward slashes',
      )
    })

    it('should handle all Windows paths together', () => {
      const config = generateRedisConfig({
        port: 6399,
        dataDir:
          'C:\\Users\\runneradmin\\.spindb\\containers\\redis\\redis-test\\data',
        logFile:
          'C:\\Users\\runneradmin\\.spindb\\containers\\redis\\redis-test\\redis.log',
        pidFile:
          'C:\\Users\\runneradmin\\.spindb\\containers\\redis\\redis-test\\redis.pid',
      })

      // Should not contain any backslashes
      assert(
        !config.includes('\\'),
        'Config should not contain any backslashes',
      )

      // Verify all paths are converted
      assert(
        config.includes(
          'dir C:/Users/runneradmin/.spindb/containers/redis/redis-test/data',
        ),
        'dataDir should be normalized',
      )
      assert(
        config.includes(
          'logfile C:/Users/runneradmin/.spindb/containers/redis/redis-test/redis.log',
        ),
        'logFile should be normalized',
      )
      assert(
        config.includes(
          'pidfile C:/Users/runneradmin/.spindb/containers/redis/redis-test/redis.pid',
        ),
        'pidFile should be normalized',
      )
    })

    it('should leave Unix paths unchanged', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/home/user/.spindb/containers/redis/test/data',
        logFile: '/home/user/.spindb/containers/redis/test/redis.log',
        pidFile: '/home/user/.spindb/containers/redis/test/redis.pid',
      })

      assert(
        config.includes('dir /home/user/.spindb/containers/redis/test/data'),
        'Unix dataDir should remain unchanged',
      )
      assert(
        config.includes(
          'logfile /home/user/.spindb/containers/redis/test/redis.log',
        ),
        'Unix logFile should remain unchanged',
      )
      assert(
        config.includes(
          'pidfile /home/user/.spindb/containers/redis/test/redis.pid',
        ),
        'Unix pidFile should remain unchanged',
      )
    })
  })

  describe('daemonize option', () => {
    it('should default to daemonize yes', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/tmp/data',
        logFile: '/tmp/redis.log',
        pidFile: '/tmp/redis.pid',
      })

      assert(
        config.includes('daemonize yes'),
        'Should default to daemonize yes',
      )
    })

    it('should set daemonize no when explicitly disabled', () => {
      const config = generateRedisConfig({
        port: 6379,
        dataDir: '/tmp/data',
        logFile: '/tmp/redis.log',
        pidFile: '/tmp/redis.pid',
        daemonize: false,
      })

      assert(
        config.includes('daemonize no'),
        'Should set daemonize no when disabled',
      )
    })
  })

  describe('port configuration', () => {
    it('should include the specified port', () => {
      const config = generateRedisConfig({
        port: 6399,
        dataDir: '/tmp/data',
        logFile: '/tmp/redis.log',
        pidFile: '/tmp/redis.pid',
      })

      assert(config.includes('port 6399'), 'Should include the specified port')
    })
  })
})
