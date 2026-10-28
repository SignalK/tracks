import { afterAll } from 'vitest'
import { removePending } from './testDirs.test-utils.js'

// Runs in every test file. Every harness makes a directory under the OS temp
// dir, about 250 a run, and on a Pi that is tmpfs: left behind, they held
// gigabytes of its memory after a few days of test runs.
afterAll(removePending)
