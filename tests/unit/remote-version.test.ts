import { describe, it } from 'node:test'
import { parseRemoteVersionOutput } from '../../engines/postgresql/remote-version'
import { assert, assertEqual } from '../utils/assertions'

// psql -t -A -F "|||" -c "SELECT version(), current_setting('server_version')"
describe('parseRemoteVersionOutput', () => {
  it('parses a release server and classifies the server type', () => {
    const result = parseRemoteVersionOutput(
      'PostgreSQL 16.4 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 12.2.0, 64-bit|||16.4\n',
    )
    assertEqual(result.majorVersion, 16, 'major')
    assertEqual(result.minorVersion, 4, 'minor')
    assertEqual(result.fullVersion, '16.4', 'full')
    assertEqual(result.serverType, 'postgresql', 'server type')
  })

  it('parses a prerelease server such as 19beta3, which has no minor', () => {
    const result = parseRemoteVersionOutput(
      'PostgreSQL 19beta3 on aarch64-unknown-linux-gnu, compiled by gcc (GCC) 14.2.0, 64-bit|||19beta3\n',
    )
    assertEqual(result.majorVersion, 19, 'major')
    assertEqual(result.minorVersion, 0, 'a prerelease has no minor')
    assertEqual(result.fullVersion, '19beta3', 'full keeps the tag')
    assertEqual(result.serverType, 'postgresql', 'server type')
  })

  it('keeps the managed-provider classification alongside the version', () => {
    const result = parseRemoteVersionOutput(
      'PostgreSQL 15.8 on x86_64-pc-linux-gnu, compiled by aurora_gcc|||15.8',
    )
    assertEqual(result.majorVersion, 15, 'major')
    assertEqual(result.serverType, 'aurora', 'aurora wins over postgresql')
  })

  it('throws on output that is not two fields', () => {
    let threw = false
    try {
      parseRemoteVersionOutput('PostgreSQL 16.4 on x86_64')
    } catch (error) {
      threw = true
      assert(
        (error as Error).message.includes('Unexpected version output format'),
        'names the shape problem',
      )
    }
    assert(threw, 'one field is not enough')
  })

  it('throws when server_version carries no version', () => {
    let threw = false
    try {
      parseRemoteVersionOutput('PostgreSQL something|||devel')
    } catch (error) {
      threw = true
      assert(
        (error as Error).message.includes('Could not parse server version'),
        'names the parse problem',
      )
    }
    assert(threw, 'devel is not a version')
  })
})
