import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mainMenuTitle } from '../../cli/ui/theme'

describe('mainMenuTitle', () => {
  const original = process.env.SPINDB_BRAND

  afterEach(() => {
    if (original === undefined) delete process.env.SPINDB_BRAND
    else process.env.SPINDB_BRAND = original
  })

  it('defaults to SpinDB', () => {
    delete process.env.SPINDB_BRAND
    assert.equal(mainMenuTitle(), 'SpinDB - Local Database Manager')
  })

  it('uses SPINDB_BRAND when set', () => {
    process.env.SPINDB_BRAND = 'Layerbase'
    assert.equal(mainMenuTitle(), 'Layerbase - Local Database Manager')
  })

  it('ignores a blank SPINDB_BRAND', () => {
    process.env.SPINDB_BRAND = '   '
    assert.equal(mainMenuTitle(), 'SpinDB - Local Database Manager')
  })
})
