// DEV ONLY: local disposable fixtures and mocked Google network, never loads .env.
// Launch the browser script in frontend/test/google-workspace.browser.mjs against this API.
import assert from 'node:assert/strict'
const url = new URL(process.env.QA_DATABASE_URL || 'postgresql://invalid/invalid')
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/techsync_product_browser', 'Disposable browser database required')
Object.assign(process.env, {
  DATABASE_URL: url.href, DATABASE_URL_UNPOOLED: url.href, NODE_ENV: 'test', LOG_LEVEL: 'silent',
  JWT_ACCESS_SECRET: 'product-review-qa-only-012345678901234567890', DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  AWS_ACCESS_KEY_ID: 'fixture-only', AWS_SECRET_ACCESS_KEY: 'fixture-only', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9',
  FRONTEND_URL: 'http://127.0.0.1:5182', CORS_ORIGINS: 'http://127.0.0.1:5182', RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_MAX: '100000', EMAIL_DELIVERY: 'queue',
  GOOGLE_WORKSPACE_ENABLED: 'true', GOOGLE_WORKSPACE_CALENDAR_ENABLED: 'true', GOOGLE_WORKSPACE_DRIVE_ENABLED: 'true', GOOGLE_WORKSPACE_SHEETS_ENABLED: 'true',
  GOOGLE_WORKSPACE_CLIENT_ID: '123456789-fixture.apps.googleusercontent.com', GOOGLE_WORKSPACE_CLIENT_SECRET: 'fixture-only', GOOGLE_WORKSPACE_PROJECT_NUMBER: '123456789',
  GOOGLE_WORKSPACE_REDIRECT_URI: 'http://127.0.0.1:5182/api/google/oauth/callback', GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  GOOGLE_GMAIL_CLIENT_ID: '', GOOGLE_AUTH_CLIENT_ID: '', GOOGLE_CLIENT_ID: '', GOOGLE_WORKSPACE_KMS_KEY_NAME: '',
})
if (process.argv.includes('--shared-project')) process.env.GOOGLE_GMAIL_CLIENT_ID = process.env.GOOGLE_WORKSPACE_CLIENT_ID
const { googleProvider } = await import('../src/integrations/google/provider.js')
const { SERVICE_SCOPES } = await import('../src/integrations/google/config.js')
googleProvider.exchange = async (code) => ({ refresh_token: 'fixture-refresh-only', id_token: 'fixture-identity-only', scope: `openid email profile ${code === 'denied' ? '' : `${SERVICE_SCOPES.calendar} ${SERVICE_SCOPES.drive}`}` })
googleProvider.identity = async () => ({ subject: 'browser-fixture-subject', email: 'google-browser@example.test' })
googleProvider.refresh = async () => ({ access_token: 'fixture-access-only', expiry_date: Date.now() + 3600000 })
googleProvider.revoke = async () => {}
const { prisma } = await import('../src/db/prisma.js')
if (process.argv.includes('--reset-fixtures')) {
  const fs = await import('node:fs/promises')
  const fixtures = JSON.parse(await fs.readFile('/tmp/techsync-product-review-fixture.json', 'utf8'))
  const organizationId = { in: fixtures.map((row) => row.orgId) }
  assert.equal(await prisma.organization.count({ where: { id: organizationId, slug: { startsWith: 'product-review-qa-' } } }), fixtures.length)
  await prisma.$transaction(async (tx) => {
    await tx.googleConnection.deleteMany({ where: { organizationId } })
    await tx.googleRevocation.deleteMany({ where: { organizationId } })
    await tx.googleWorkspaceOAuthState.deleteMany({ where: { organizationId } })
    await tx.googleWorkspaceSettings.deleteMany({ where: { organizationId } })
    await tx.googleSyncLog.deleteMany({ where: { organizationId } })
  })
}
const { startQueue, stopQueue } = await import('../src/jobs/queue.js')
await startQueue({ role: 'api' })
const { default: app } = await import('../src/app.js')
const server = app.listen(5063, '127.0.0.1', () => console.log('Mock Google QA API http://127.0.0.1:5063 (local synthetic data only)'))
const shutdown = async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await stopQueue(); await prisma.$disconnect(); process.exit(0) }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
