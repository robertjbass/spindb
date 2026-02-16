import { describe, it } from 'node:test'
import { platform as osPlatform } from 'os'
import { join } from 'path'
import { getLibraryEnv, detectLibraryError } from '../../core/library-env'
import { assert, assertEqual } from '../utils/assertions'

describe('library-env', () => {
  describe('getLibraryEnv', () => {
    const binPath = '/home/user/.spindb/bin/redis-8.4.0-linux-arm64'

    it('should return an object with the correct library path', () => {
      const result = getLibraryEnv(binPath)
      const plat = osPlatform()

      if (plat === 'darwin') {
        assert(result !== undefined, 'Should return env on macOS')
        assertEqual(
          result!.DYLD_FALLBACK_LIBRARY_PATH,
          join(binPath, 'lib'),
          'Should set DYLD_FALLBACK_LIBRARY_PATH',
        )
      } else if (plat === 'linux') {
        assert(result !== undefined, 'Should return env on Linux')
        assertEqual(
          result!.LD_LIBRARY_PATH,
          join(binPath, 'lib'),
          'Should set LD_LIBRARY_PATH',
        )
      } else if (plat === 'win32') {
        assertEqual(
          result,
          undefined,
          'Should return undefined on Windows',
        )
      }
    })

    it('should point to the lib subdirectory of binPath', () => {
      const result = getLibraryEnv(binPath)
      const plat = osPlatform()

      if (plat === 'win32') return

      assert(result !== undefined, 'Should return env on Unix')
      const values = Object.values(result!)
      assert(values.length === 1, 'Should have exactly one env var')
      assert(
        values[0].endsWith('/lib'),
        `Path should end with /lib, got: ${values[0]}`,
      )
    })
  })

  describe('detectLibraryError', () => {
    it('should detect macOS dyld Library not loaded errors', () => {
      const output =
        'dyld[12345]: Library not loaded: /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'
      const result = detectLibraryError(output, 'Redis')
      assert(result !== null, 'Should detect dyld error')
      assert(
        result!.includes('Redis'),
        'Should include engine name in message',
      )
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
      assert(
        result!.includes('Valkey'),
        'Should include engine name',
      )
    })

    it('should detect GLIBC version errors', () => {
      const output =
        '/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34` not found'
      const result = detectLibraryError(output, 'Redis')
      assert(result !== null, 'Should detect GLIBC error')
      assert(
        result!.includes('GLIBC'),
        'Should mention GLIBC in message',
      )
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
      const output =
        'dyld[45678]: Library not loaded: @rpath/libssl.3.dylib'
      const result = detectLibraryError(output, 'Valkey')
      assert(result !== null, 'Should detect dyld[pid] format')
    })

    it('should detect libc.so reference as GLIBC error', () => {
      const output = 'error: libc.so.6: cannot handle TLS data'
      const result = detectLibraryError(output, 'MariaDB')
      assert(result !== null, 'Should detect libc.so error')
      assert(
        result!.includes('GLIBC'),
        'Should mention GLIBC in the message',
      )
    })
  })
})
