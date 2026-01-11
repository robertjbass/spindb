#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Path to the main TypeScript entry point
const mainScript = join(__dirname, '..', 'cli', 'bin.ts')

// Detect Windows
const isWindows = process.platform === 'win32'

// Use tsx to execute the TypeScript file
// On Windows, tsx is a .cmd file that requires shell: true to execute
const tsxPath = join(__dirname, '..', 'node_modules', '.bin', 'tsx')

// Spawn tsx process with the main script and pass through all arguments
// Windows requires shell: true to execute .cmd files from node_modules/.bin
const child = spawn(tsxPath, [mainScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: isWindows,
})

// Forward exit code
child.on('exit', (code) => {
  process.exit(code ?? 0)
})

// Handle errors
child.on('error', (err) => {
  console.error('Failed to start spindb:', err.message)
  process.exit(1)
})
