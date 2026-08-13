import { defineConfig } from 'vitest/config'

// The e2e tier: a real Signal K server, and for the backfill tests a real
// QuestDB. Serial and long-timeout because each file boots a server process.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
