import { defineConfig } from '@prisma/prisma7/config'

// The application and its existing SQL migrations use ORM 7. Keep this config separate
// from the installed Prisma 8 RC CLI until migration ownership is explicitly transferred.

// Prisma 7 no longer reads .env automatically. Load it if present (CI/production inject real env vars).
try {
  process.loadEnvFile('.env')
} catch {
  /* no .env file */
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Migrations need a DIRECT connection (not through PgBouncer). The app itself uses the
    // pooled DATABASE_URL via the pg driver adapter — see src/db/prisma.js.
    url: process.env.DATABASE_URL_UNPOOLED,
  },
})
