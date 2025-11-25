#!/usr/bin/env tsx

import { run } from './index'

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
