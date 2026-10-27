import { describe, it } from 'node:test'
import { COMMAND_ENTRIES, selectCommandEntries } from '../../cli/index'
import { loadEngine } from '../../engines/loader'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { assert, assertEqual } from '../utils/assertions'

describe('lazy CLI command registry', () => {
  it('lists each command under its real name and aliases', async () => {
    for (const entry of COMMAND_ENTRIES) {
      const command = await entry.load()
      assertEqual(
        JSON.stringify(entry.names),
        JSON.stringify([command.name(), ...command.aliases()]),
        `names for "${command.name()}" must match the command module`,
      )
    }
  })

  it('never maps one name to two commands', () => {
    const names = COMMAND_ENTRIES.flatMap((entry) => entry.names)
    assertEqual(new Set(names).size, names.length, 'duplicate command name')
  })

  it('loads only the dispatched command for a name or alias', () => {
    for (const entry of COMMAND_ENTRIES) {
      for (const name of entry.names) {
        const selected = selectCommandEntries([name, '--json'])
        assertEqual(selected.length, 1, `"${name}" should load one command`)
        assert(selected[0] === entry, `"${name}" should load its own entry`)
      }
    }
  })

  it('loads nothing for the root version flag', () => {
    assertEqual(selectCommandEntries(['--version']).length, 0, '--version')
    assertEqual(selectCommandEntries(['-v', 'list']).length, 0, '-v')
  })

  it('loads every command, in order, for help and unknown input', () => {
    for (const args of [
      [],
      ['--help'],
      ['-h'],
      ['help', 'list'],
      ['lst'],
      ['--bogus', 'list'],
    ]) {
      assert(
        selectCommandEntries(args) === COMMAND_ENTRIES,
        `${JSON.stringify(args)} should load every command`,
      )
    }
  })
})

describe('loadEngine', () => {
  it('returns the same singleton as getEngine for every engine', async () => {
    for (const engine of Object.values(Engine)) {
      assert(
        (await loadEngine(engine)) === getEngine(engine),
        `${engine} should resolve to the registry instance`,
      )
    }
  })

  it('resolves aliases and mixed case through the full registry', async () => {
    assert((await loadEngine('pg')) === getEngine('pg'), 'pg alias')
    assert(
      (await loadEngine('PostgreSQL')) === getEngine('postgresql'),
      'mixed case',
    )
  })

  it('throws the same error as getEngine for an unknown engine', async () => {
    let expected = ''
    try {
      getEngine('nope')
    } catch (error) {
      expected = (error as Error).message
    }
    let actual = ''
    try {
      await loadEngine('nope')
    } catch (error) {
      actual = (error as Error).message
    }
    assert(expected.startsWith('Unknown engine "nope"'), 'getEngine throws')
    assertEqual(actual, expected, 'loadEngine error message')
  })
})
