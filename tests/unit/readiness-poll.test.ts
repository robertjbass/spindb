import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pollUntilReady } from '../../core/readiness-poll'

function fakeClock() {
  let time = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      time += ms
    },
  }
}

describe('pollUntilReady', () => {
  it('checks immediately and does not sleep when already ready', async () => {
    const clock = fakeClock()
    let checks = 0
    const ready = await pollUntilReady(
      async () => {
        checks++
        return true
      },
      { timeoutMs: 1000, now: clock.now, sleep: clock.sleep },
    )
    assert.equal(ready, true)
    assert.equal(checks, 1)
    assert.deepEqual(clock.sleeps, [])
  })

  it('backs off from 50 ms to a 250 ms ceiling and treats throws as not ready', async () => {
    const clock = fakeClock()
    let checks = 0
    const ready = await pollUntilReady(
      async () => {
        checks++
        if (checks < 6) throw new Error('connection refused')
        return true
      },
      { timeoutMs: 30000, now: clock.now, sleep: clock.sleep },
    )
    assert.equal(ready, true)
    assert.deepEqual(clock.sleeps, [50, 100, 200, 250, 250])
  })

  it('gives up at the deadline without sleeping past it', async () => {
    const clock = fakeClock()
    const ready = await pollUntilReady(async () => false, {
      timeoutMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    })
    assert.equal(ready, false)
    assert.equal(clock.now(), 1000)
    assert.deepEqual(clock.sleeps, [50, 100, 200, 250, 250, 150])
  })

  it('stops when asked to', async () => {
    const clock = fakeClock()
    let stopped = false
    let checks = 0
    const ready = await pollUntilReady(
      async () => {
        checks++
        if (checks === 2) stopped = true
        return false
      },
      {
        timeoutMs: 30000,
        shouldStop: () => stopped,
        now: clock.now,
        sleep: clock.sleep,
      },
    )
    assert.equal(ready, false)
    assert.equal(checks, 2)
  })
})
