/**
 * Stand-in for a `spindb restore --from-url` that is terminated mid-dump.
 *
 * Registers a temp dump path exactly as the restore commands do, writes a
 * partial file to it, spawns a slow fake dump client, then waits. The test
 * SIGTERMs this process and checks that the file is gone, the fake client is
 * dead, and the exit code is the conventional 143.
 *
 * Run as: node --import tsx terminated-dump.ts <dumpPath>
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  registerTempDump,
  trackDumpProcess,
} from '../../../core/temp-dump-cleanup'

const dumpPath = process.argv[2]
if (!dumpPath) {
  throw new Error('a dump path argument is required')
}

registerTempDump(dumpPath)
writeFileSync(dumpPath, 'partial dump contents\n')

// A child that outlives its parent unless something kills it, standing in for
// mysqldump still streaming rows when the deadline lands.
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
  stdio: 'ignore',
})
trackDumpProcess(child)

process.stdout.write(`ready ${child.pid}\n`)

// Keep the process alive the way an in-flight dump would.
setInterval(() => {}, 1000)
