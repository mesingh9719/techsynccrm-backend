import { defineConfig } from 'vitest/config'

// Unit tests run offline. Integration tests are opt-in via TEST_DATABASE_URL; see backend/README.md.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // CREATE INDEX CONCURRENTLY waits for other test-file transactions in the shared disposable
    // database. Serialize files, retaining concurrency exercised explicitly within each test.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
})
