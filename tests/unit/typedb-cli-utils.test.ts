/**
 * Unit tests for TypeDB CLI utilities
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { detectTypedbTxType } from '../../engines/typedb/cli-utils'

describe('TypeDB CLI Utils', () => {
  describe('detectTypedbTxType', () => {
    it('classifies define/undefine/redefine as schema', () => {
      assert.strictEqual(
        detectTypedbTxType('define entity person owns name;'),
        'schema',
      )
      assert.strictEqual(
        detectTypedbTxType('undefine owns name from person;'),
        'schema',
      )
      assert.strictEqual(
        detectTypedbTxType('redefine attribute name value string;'),
        'schema',
      )
    })

    it('classifies data-mutation clauses as write', () => {
      assert.strictEqual(
        detectTypedbTxType('insert $a isa person, has name "Alice";'),
        'write',
      )
      assert.strictEqual(
        detectTypedbTxType('match $p isa person; delete $p;'),
        'write',
      )
      assert.strictEqual(
        detectTypedbTxType('match $p isa person; update $p has age 30;'),
        'write',
      )
      assert.strictEqual(
        detectTypedbTxType('put $a isa person, has name "Alice";'),
        'write',
      )
    })

    it('classifies match/fetch/reduce as read', () => {
      assert.strictEqual(detectTypedbTxType('match $p isa person;'), 'read')
      assert.strictEqual(
        detectTypedbTxType('match $p isa person; fetch { "name": $p.name };'),
        'read',
      )
      assert.strictEqual(
        detectTypedbTxType('match $p isa person; reduce $c = count;'),
        'read',
      )
    })

    it('treats a match...insert relation pipeline as write (not read)', () => {
      // The headline bug: starts with `match` but is a write. Must not be read,
      // or TypeDB rejects it with [TSV9] under a read transaction.
      const rel =
        'match $a isa person, has name "Alice"; $b isa person, has name "Bob"; insert (a: $a, b: $b) isa knows;'
      assert.strictEqual(detectTypedbTxType(rel), 'write')
    })

    it('lets schema win over a write clause appearing later', () => {
      assert.strictEqual(
        detectTypedbTxType('define entity person; insert $a isa person;'),
        'schema',
      )
    })

    it('ignores keywords inside line comments', () => {
      assert.strictEqual(
        detectTypedbTxType('# this will insert nothing\nmatch $p isa person;'),
        'read',
      )
      assert.strictEqual(
        detectTypedbTxType('// define is mentioned here\nmatch $p isa person;'),
        'read',
      )
    })

    it('ignores keywords inside string values', () => {
      // An insert whose value contains `define`/`redefine` must stay write -
      // misclassifying it schema would open a schema txn and the insert fails.
      assert.strictEqual(
        detectTypedbTxType(
          'insert $t isa task, has title "define the roadmap";',
        ),
        'write',
      )
      assert.strictEqual(
        detectTypedbTxType(
          'match $x isa note, has body "please insert later";',
        ),
        'read',
      )
    })

    it('does not match keywords embedded in identifiers', () => {
      // `insertion_date` / `updated` must not flip a read to a write.
      assert.strictEqual(
        detectTypedbTxType('match $p isa person, has insertion_date $d;'),
        'read',
      )
    })

    it('is case-insensitive', () => {
      assert.strictEqual(detectTypedbTxType('DEFINE entity person;'), 'schema')
      assert.strictEqual(detectTypedbTxType('INSERT $a isa person;'), 'write')
    })
  })
})
