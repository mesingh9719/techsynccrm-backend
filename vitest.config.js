import { defineConfig } from 'vitest/config'

// Unit tests run offline. Integration tests are opt-in via TEST_DATABASE_URL; see backend/README.md.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
})
