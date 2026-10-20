import { prisma } from '../src/db/prisma.js'
import { recordAudit } from '../src/lib/audit.js'

// Operator-only recovery. Uses an internal request UUID from worker logs, not a public status code.
const id = process.argv[2]
try {
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('Usage: node --env-file-if-exists=.env scripts/retry-facebook-deletion.js <request-uuid>')
  await prisma.$transaction(async (tx) => {
    const changed = await tx.facebookDeletionRequest.updateMany({ where: { id, status: 'failed', subjectEnc: { not: null } }, data: { status: 'queued', attempts: 0, nextAttemptAt: new Date(), leaseUntil: null, lastError: null } })
    if (!changed.count) throw new Error('No failed deletion request with a retained subject was found. Completed requests cannot be retried.')
    await recordAudit(tx, { actorType: 'system' }, { action: 'facebook.deletion_retried', entityType: 'facebook_deletion_request', entityId: id })
  })
  console.log('Deletion request queued. The running worker recovery schedule will pick it up.')
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally { await prisma.$disconnect() }
