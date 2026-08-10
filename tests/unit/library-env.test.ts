import { describe, it } from 'node:test'
import { platform as osPlatform } from 'os'
import { join } from 'path'
import {
  getLibraryEnv,
  getWindowsDllEnv,
  prependPath,
  detectLibraryError,
} from '../../core/library-env'
import { assert, assertEqual } from '../utils/assertions'

// The unit suite runs with --experimental-test-isolation=none, so every test
// shares one process: any process.env write has to be restored or it leaks
// into unrelated tests.
function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const had = Object.hasOwn(process.env, key)
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return fn()
  } finally {
    if (had) process.env[key] = previous
    else delete process.env[key]
  }
}

const LIBRARY_PATH_VAR: Record<string, string> = {
  darwin: 'DYLD_FALLBACK_LIBRARY_PATH',
  linux: 'LD_LIBRARY_PATH',
}

describe('library-env', () => {
  describe('getLibraryEnv', () => {
    const binPath = '/home/user/.spindb/bin/redis-8.4.0-linux-arm64'
    const plat = osPlatform()
    const envVar = LIBRARY_PATH_VAR[plat]

    it('should return an object with the correct library path', () => {
      if (!envVar) {
        assertEqual(
          getLibraryEnv(binPath),
          undefined,
          'Should return undefined on Windows',
        )
        return
      }

      withEnv(envVar, undefined, () => {
        const result = getLibraryEnv(binPath)
        assert(result !== undefined, `Should return env on ${plat}`)
        assertEqual(
          result![envVar],
          join(binPath, 'lib'),
          `Should set ${envVar}`,
        )
      })
    })

    it('should point to the lib subdirectory of binPath', () => {
      if (!envVar) return

      withEnv(envVar, undefined, () => {
        const result = getLibraryEnv(binPath)
        assert(result !== undefined, 'Should return env on Unix')
        const values = Object.values(result!)
        assert(values.length === 1, 'Should have exactly one env var')
        assert(
          values[0].endsWith('/lib'),
          `Path should end with /lib, got: ${values[0]}`,
        )
      })
    })

    it("should PREPEND to the caller's existing library path, not replace it", () => {
      if (!envVar) return

      withEnv(envVar, '/opt/mylibs:/usr/local/custom/lib', () => {
        const result = getLibraryEnv(binPath)
        assert(result !== undefined, 'Should return env on Unix')
        assertEqual(
          result![envVar],
          `${join(binPath, 'lib')}:/opt/mylibs:/usr/local/custom/lib`,
          'Bundled lib dir should win, existing entries should survive behind it',
        )
      })
    })

    it('should not emit a trailing separator when the existing value is empty', () => {
      if (!envVar) return

      withEnv(envVar, '', () => {
        const result = getLibraryEnv(binPath)
        assertEqual(
          result![envVar],
          join(binPath, 'lib'),
          'Empty existing value should yield just the lib dir',
        )
      })
    })
  })

  describe('getWindowsDllEnv', () => {
    it('should return undefined off Windows', () => {
      if (osPlatform() === 'win32') return
      assertEqual(
        getWindowsDllEnv('C:\\bin\\influxdb\\python'),
        undefined,
        'Only Windows needs the PATH treatment',
      )
    })

    it('should prepend the DLL dir to PATH on Windows', () => {
      if (osPlatform() !== 'win32') return

      withEnv('PATH', 'C:\\Windows\\System32', () => {
        assertEqual(
          getWindowsDllEnv('C:\\bin\\influxdb\\python')!.PATH,
          'C:\\bin\\influxdb\\python;C:\\Windows\\System32',
          'Bundled DLL dir must come first so a stray same-named DLL cannot win',
        )
      })
    })
  })

  // Covers the Windows separator on non-Windows runners: getWindowsDllEnv
  // itself early-returns off win32, so without this the ';' branch would
  // never execute in CI.
  describe('prependPath', () => {
    it('should place the new directory first', () => {
      assertEqual(
        prependPath('/new', '/old', ':'),
        '/new:/old',
        'New directory should come first',
      )
    })

    it('should preserve every existing entry in order', () => {
      assertEqual(
        prependPath('/new', '/a:/b:/c', ':'),
        '/new:/a:/b:/c',
        'Existing entries should survive in their original order',
      )
    })

    it('should use the Windows separator when asked', () => {
      assertEqual(
        prependPath('C:\\new', 'C:\\Windows\\System32', ';'),
        'C:\\new;C:\\Windows\\System32',
        'Windows paths join with a semicolon',
      )
    })

    it('should return just the directory when nothing exists', () => {
      assertEqual(
        prependPath('/new', undefined, ':'),
        '/new',
        'Absent existing value should not add a separator',
      )
      assertEqual(
        prependPath('/new', '', ':'),
        '/new',
        'Empty existing value should not add a separator',
      )
    })
  })

  describe('detectLibraryError', () => {
    it('should detect macOS dyld Library not loaded errors', () => {
      const output =
        'dyld[12345]: Library not loaded: /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'
      const result = detectLibraryError(output, 'Redis')
      assert(result !== null, 'Should detect dyld error')
      assert(result!.includes('Redis'), 'Should include engine name in message')
    })

    it('should suggest brew install openssl@3 for macOS SSL errors', () => {
      const output =
        'dyld: Library not loaded: /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'
      const result = detectLibraryError(output, 'MariaDB')

      assert(result !== null, 'Should detect SSL library error')
      if (osPlatform() === 'darwin') {
        assert(
          result!.includes('brew install openssl@3'),
          'Should suggest brew install on macOS',
        )
      }
    })

    it('should detect libcrypto loading errors', () => {
      const output =
        'dyld[999]: Library not loaded: /opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib'
      const result = detectLibraryError(output, 'Valkey')
      assert(result !== null, 'Should detect libcrypto error')
      assert(result!.includes('Valkey'), 'Should include engine name')
    })

    it('should detect GLIBC version errors', () => {
      const output =
        '/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34` not found'
      const result = detectLibraryError(output, 'Redis')
      assert(result !== null, 'Should detect GLIBC error')
      assert(result!.includes('GLIBC'), 'Should mention GLIBC in message')
    })

    it('should detect Linux shared library errors', () => {
      const output =
        'redis-server: error while loading shared libraries: libssl.so.3: cannot open shared object file: No such file or directory'
      const result = detectLibraryError(output, 'Redis')
      assert(result !== null, 'Should detect shared library error')
      assert(
        result!.includes('OpenSSL') || result!.includes('libssl'),
        'Should reference SSL in message',
      )
    })

    it('should detect generic shared library errors', () => {
      const output =
        'error while loading shared libraries: libfoo.so: cannot open shared object file'
      const result = detectLibraryError(output, 'MariaDB')
      assert(result !== null, 'Should detect generic shared lib error')
      assert(
        result!.includes('shared library'),
        'Should mention shared library',
      )
    })

    it('should return null for non-library errors', () => {
      const output = 'Address already in use'
      const result = detectLibraryError(output, 'Redis')
      assertEqual(result, null, 'Should return null for port error')
    })

    it('should return null for empty output', () => {
      assertEqual(
        detectLibraryError('', 'Redis'),
        null,
        'Should return null for empty string',
      )
    })

    it('should return null for normal startup output', () => {
      const output =
        'Server initialized\nReady to accept connections on port 6379'
      assertEqual(
        detectLibraryError(output, 'Redis'),
        null,
        'Should return null for normal output',
      )
    })

    it('should detect dyld with bracket notation', () => {
      const output = 'dyld[45678]: Library not loaded: @rpath/libssl.3.dylib'
      const result = detectLibraryError(output, 'Valkey')
      assert(result !== null, 'Should detect dyld[pid] format')
    })

    it('should detect libc.so reference as GLIBC error', () => {
      const output = 'error: libc.so.6: cannot handle TLS data'
      const result = detectLibraryError(output, 'MariaDB')
      assert(result !== null, 'Should detect libc.so error')
      assert(result!.includes('GLIBC'), 'Should mention GLIBC in the message')
    })
  })
})
