#!/usr/bin/env tsx

import { run } from './index'

run().catch((err) => {
  console.error(err)
  console.error('')
  console.error('If this error persists, try running: spindb doctor --fix')
  process.exit(1)
})
