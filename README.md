# Backend

The application currently uses Prisma ORM 7.10.1. Prisma 8 RC is also installed;
the existing schema and SQL migrations remain owned by ORM 7 until a full
runtime and migration upgrade is completed.

The npm scripts use the official `@prisma/prisma7` CLI and its automatically
discovered `prisma7.config.ts`. That config loads `.env` and uses
`DATABASE_URL_UNPOOLED` for migrations.

```bash
npm install
npm run db:status       # Read migration status
npm run db:migrate      # Apply pending SQL migrations
npm run db:generate     # Regenerate the application's ORM 7 client
npm run build
npm test
```

Use `npm run db:migrate:dev -- --name <change>` to author migrations against a
development database. Keep the existing migration history in `prisma/migrations`.

`npx prisma` runs the Prisma 8 RC CLI; the commands above use `prisma7`.
Do not substitute Prisma 8's migration commands for the existing migration
scripts until migration ownership is deliberately transferred.

See Prisma's [incremental PostgreSQL upgrade guide](https://docs.prisma.io/docs/guides/upgrade-prisma-orm/postgresql).

## Notifications (M11)

After updating dependencies, apply the notification migration and regenerate the client:

```bash
npm run db:migrate
npm run build
```

Restart the API and worker (`npm start` and `npm run worker`, in separate processes).
The worker processes notification events, email batches, daily digests and retention cleanup.
Configure SMTP using the existing mail settings to deliver emails. The API uses
`DATABASE_URL_UNPOOLED` for its dedicated Postgres LISTEN connection; a transaction-pooler URL
cannot substitute for this direct connection. The frontend polls every 60 seconds if SSE is
unavailable. Preferences are under Settings → Notifications.

The M11 migration was verified against an isolated PostgreSQL database; it has not been applied
to your application database by this implementation.

Normal `npm test` runs offline tests and skips database integration tests. To run M11 integration
tests, first apply the migration history to a dedicated disposable test database, then run:

```bash
TEST_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/techsync_test' npm run test:integration
```

Never point this at your application database. Tests create and delete fixture workspaces, and
exercise global queue/retention scans. Remote test databases additionally require the explicit
`TEST_DATABASE_DISPOSABLE=true` flag. SMTP and queue enqueue calls are mocked; HTTP routes,
transactions, grouping, email reservations and Postgres LISTEN/NOTIFY use the real database.
