import { describe, it } from 'node:test'
import { assert, assertEqual } from '../integration/helpers'

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

// Container name validation (same logic as in edit.ts and prompts.ts)
function isValidContainerName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
}

// Version comparison (same logic as in engines.ts and menu.ts)
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((p) => parseInt(p, 10) || 0)
  const partsB = b.split('.').map((p) => parseInt(p, 10) || 0)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA !== numB) return numA - numB
  }
  return 0
}

// Bytes formatting (same logic as in engines.ts and menu.ts)
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

describe('Container name validation', () => {
  describe('valid names', () => {
    it('should accept simple alphabetic names', () => {
      assert(isValidContainerName('mydb'), 'mydb should be valid')
      assert(isValidContainerName('test'), 'test should be valid')
      assert(isValidContainerName('PostgreSQL'), 'PostgreSQL should be valid')
    })

    it('should accept names with numbers after first character', () => {
      assert(isValidContainerName('db1'), 'db1 should be valid')
      assert(isValidContainerName('test123'), 'test123 should be valid')
      assert(isValidContainerName('v2db'), 'v2db should be valid')
    })

    it('should accept names with hyphens', () => {
      assert(isValidContainerName('my-db'), 'my-db should be valid')
      assert(
        isValidContainerName('test-container-1'),
        'test-container-1 should be valid',
      )
    })

    it('should accept names with underscores', () => {
      assert(isValidContainerName('my_db'), 'my_db should be valid')
      assert(
        isValidContainerName('test_container_1'),
        'test_container_1 should be valid',
      )
    })

    it('should accept names with mixed allowed characters', () => {
      assert(
        isValidContainerName('my-test_db123'),
        'my-test_db123 should be valid',
      )
      assert(isValidContainerName('A1_b-2'), 'A1_b-2 should be valid')
    })
  })

  describe('invalid names', () => {
    it('should reject names starting with numbers', () => {
      assert(
        !isValidContainerName('1db'),
        'Names starting with numbers should be invalid',
      )
      assert(!isValidContainerName('123test'), '123test should be invalid')
    })

    it('should reject names starting with special characters', () => {
      assert(
        !isValidContainerName('-db'),
        'Names starting with hyphen should be invalid',
      )
      assert(
        !isValidContainerName('_db'),
        'Names starting with underscore should be invalid',
      )
    })

    it('should reject names with spaces', () => {
      assert(
        !isValidContainerName('my db'),
        'Names with spaces should be invalid',
      )
      assert(
        !isValidContainerName('test container'),
        'test container should be invalid',
      )
    })

    it('should reject names with special characters', () => {
      assert(!isValidContainerName('my@db'), 'Names with @ should be invalid')
      assert(
        !isValidContainerName('test.container'),
        'Names with periods should be invalid',
      )
      assert(!isValidContainerName('db!'), 'Names with ! should be invalid')
    })

    it('should reject empty names', () => {
      assert(!isValidContainerName(''), 'Empty names should be invalid')
    })
  })
})

describe('Port validation', () => {
  describe('valid ports', () => {
    it('should accept standard database ports', () => {
      assert(isValidPort(5432), 'PostgreSQL default port should be valid')
      assert(isValidPort(3306), 'MySQL default port should be valid')
    })

    it('should accept minimum port', () => {
      assert(isValidPort(1), 'Port 1 should be valid')
    })

    it('should accept maximum port', () => {
      assert(isValidPort(65535), 'Port 65535 should be valid')
    })

    it('should accept arbitrary valid ports', () => {
      assert(isValidPort(8080), 'Port 8080 should be valid')
      assert(isValidPort(3000), 'Port 3000 should be valid')
    })
  })

  describe('invalid ports', () => {
    it('should reject port 0', () => {
      assert(!isValidPort(0), 'Port 0 should be invalid')
    })

    it('should reject negative ports', () => {
      assert(!isValidPort(-1), 'Negative ports should be invalid')
      assert(!isValidPort(-5432), '-5432 should be invalid')
    })

    it('should reject ports above maximum', () => {
      assert(!isValidPort(65536), 'Port 65536 should be invalid')
      assert(!isValidPort(100000), 'Port 100000 should be invalid')
    })

    it('should reject non-integer values', () => {
      assert(!isValidPort(5432.5), 'Decimal ports should be invalid')
      assert(!isValidPort(NaN), 'NaN should be invalid')
      assert(!isValidPort(Infinity), 'Infinity should be invalid')
    })
  })
})

describe('Version comparison', () => {
  describe('major version differences', () => {
    it('should compare major versions correctly', () => {
      assert(compareVersions('17', '16') > 0, '17 should be greater than 16')
      assert(compareVersions('15', '16') < 0, '15 should be less than 16')
      assert(compareVersions('16', '16') === 0, '16 should equal 16')
    })
  })

  describe('minor version differences', () => {
    it('should compare minor versions correctly', () => {
      assert(
        compareVersions('16.2', '16.1') > 0,
        '16.2 should be greater than 16.1',
      )
      assert(
        compareVersions('16.1', '16.2') < 0,
        '16.1 should be less than 16.2',
      )
      assert(compareVersions('16.1', '16.1') === 0, '16.1 should equal 16.1')
    })
  })

  describe('patch version differences', () => {
    it('should compare patch versions correctly', () => {
      assert(
        compareVersions('16.1.2', '16.1.1') > 0,
        '16.1.2 should be greater than 16.1.1',
      )
      assert(
        compareVersions('16.1.1', '16.1.2') < 0,
        '16.1.1 should be less than 16.1.2',
      )
      assert(
        compareVersions('16.1.1', '16.1.1') === 0,
        '16.1.1 should equal 16.1.1',
      )
    })
  })

  describe('mixed version formats', () => {
    it('should handle versions with different component counts', () => {
      assert(
        compareVersions('16.1.0', '16.1') === 0,
        '16.1.0 should equal 16.1',
      )
      assert(compareVersions('16', '16.0') === 0, '16 should equal 16.0')
      assert(compareVersions('16', '16.0.0') === 0, '16 should equal 16.0.0')
    })

    it('should compare versions with different lengths', () => {
      assert(
        compareVersions('16.1', '16.0.5') > 0,
        '16.1 should be greater than 16.0.5',
      )
      assert(
        compareVersions('16.0.5', '16.1') < 0,
        '16.0.5 should be less than 16.1',
      )
    })
  })

  describe('edge cases', () => {
    it('should handle version 10 correctly', () => {
      assert(compareVersions('16', '10') > 0, '16 should be greater than 10')
      assert(compareVersions('10', '9') > 0, '10 should be greater than 9')
    })

    it('should handle version 0 components', () => {
      assert(compareVersions('16.0', '16') === 0, '16.0 should equal 16')
      assert(
        compareVersions('16.0.1', '16.0') > 0,
        '16.0.1 should be greater than 16.0',
      )
    })
  })
})

describe('Bytes formatting', () => {
  describe('bytes', () => {
    it('should format zero bytes', () => {
      assertEqual(formatBytes(0), '0 B', 'Zero should format as 0 B')
    })

    it('should format small byte values', () => {
      assertEqual(
        formatBytes(500),
        '500.0 B',
        '500 bytes should format correctly',
      )
      assertEqual(formatBytes(1), '1.0 B', '1 byte should format correctly')
    })
  })

  describe('kilobytes', () => {
    it('should format kilobyte values', () => {
      assertEqual(formatBytes(1024), '1.0 KB', '1024 bytes should be 1.0 KB')
      assertEqual(formatBytes(1536), '1.5 KB', '1536 bytes should be 1.5 KB')
    })
  })

  describe('megabytes', () => {
    it('should format megabyte values', () => {
      assertEqual(
        formatBytes(1024 * 1024),
        '1.0 MB',
        '1 MB should format correctly',
      )
      assertEqual(
        formatBytes(45 * 1024 * 1024),
        '45.0 MB',
        '45 MB should format correctly',
      )
    })
  })

  describe('gigabytes', () => {
    it('should format gigabyte values', () => {
      assertEqual(
        formatBytes(1024 * 1024 * 1024),
        '1.0 GB',
        '1 GB should format correctly',
      )
      assertEqual(
        formatBytes(2.5 * 1024 * 1024 * 1024),
        '2.5 GB',
        '2.5 GB should format correctly',
      )
    })
  })
})

describe('Connection string building', () => {
  // Test connection string patterns
  function buildPostgresConnectionString(
    port: number,
    database: string,
    user = 'postgres',
    host = '127.0.0.1',
  ): string {
    return `postgresql://${user}@${host}:${port}/${database}`
  }

  function buildMysqlConnectionString(
    port: number,
    database: string,
    user = 'root',
    host = '127.0.0.1',
  ): string {
    return `mysql://${user}@${host}:${port}/${database}`
  }

  describe('PostgreSQL connection strings', () => {
    it('should build basic connection string', () => {
      const connStr = buildPostgresConnectionString(5432, 'mydb')
      assertEqual(
        connStr,
        'postgresql://postgres@127.0.0.1:5432/mydb',
        'Should build correct URL',
      )
    })

    it('should include custom port', () => {
      const connStr = buildPostgresConnectionString(5433, 'testdb')
      assert(connStr.includes(':5433/'), 'Should include custom port')
    })
  })

  describe('MySQL connection strings', () => {
    it('should build basic connection string', () => {
      const connStr = buildMysqlConnectionString(3306, 'mydb')
      assertEqual(
        connStr,
        'mysql://root@127.0.0.1:3306/mydb',
        'Should build correct URL',
      )
    })

    it('should include custom port', () => {
      const connStr = buildMysqlConnectionString(3307, 'testdb')
      assert(connStr.includes(':3307/'), 'Should include custom port')
    })
  })
})
