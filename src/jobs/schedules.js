import { runImport, runImportPreview, runExport, recoverTransfers } from '../services/transfer.service.js'
import { sendQueued as sendGmail } from '../integrations/gmail/jobs.js'
import { maintainGmail } from '../integrations/gmail/maintenance.js'
import { syncMailbox } from '../integrations/gmail/jobs.js'
import '../integrations/gmail/hooks.js'
import { processFacebookDelivery, syncFacebookForm, recoverFacebookJobs } from '../integrations/facebook/capture.js'
import { processFacebookDeletion, recoverFacebookDeletions } from '../integrations/facebook/deletion.js'
import { maintainFiles } from '../services/file.service.js'
import { queueNotificationEmails, queueNotificationDigests, deliverNotificationBatch, cleanupNotifications } from '../services/notificationDelivery.service.js'
import { registerHandler, schedule } from './queue.js'
import { sendQueuedEmail } from './handlers/email.js'
import { cleanupExpiredTokens } from './handlers/tokens.js'
import { reassignRecords } from '../services/reassign.service.js'
import { expireTrials, recountAllUsage, sendTrialReminders } from '../services/plan.service.js'
import { rescoreAllLeads } from '../services/lead.service.js'
import { purgeDeletedRecords } from '../services/purge.service.js'
// Record services register their tables for `members.reassign` (registerReassignable) on import.
import '../services/company.service.js'
import '../services/contact.service.js'
import { scanRottingDeals } from '../services/deal.service.js'
import { scanOverdueTasks, sendDueReminders } from '../services/task.service.js'

/** Registers every job handler and cron schedule. Called once by the worker after the queue starts. */
export async function registerJobs() {
  await registerHandler('gmail.send', (job) => sendGmail(job.data), { concurrency: 2 })
  await registerHandler('gmail.sync', (job) => syncMailbox(job.data), { concurrency: 2 })
  await registerHandler('gmail.maintain', () => maintainGmail())
  await schedule('gmail.maintain', '* * * * *', null, { tz: 'UTC' })
  await registerHandler('facebook.delete', (job) => processFacebookDeletion(job.data.requestId), { concurrency: 2 })
  await registerHandler('facebook.privacy_recover', recoverFacebookDeletions)
  await schedule('facebook.privacy_recover', '* * * * *', null, { tz: 'UTC' })
  await registerHandler('facebook.lead', (job) => processFacebookDelivery(job.data.deliveryId), { concurrency: 3 })
  await registerHandler('facebook.sync', (job) => syncFacebookForm(job.data.formId))
  await registerHandler('facebook.recover', recoverFacebookJobs)
  await schedule('facebook.recover', '* * * * *', null, { tz: 'UTC' })
  await registerHandler('import.preview', (job) => runImportPreview(job.data.importId, job.data.revision))
  await registerHandler('import.run', (job) => runImport(job.data.importId))
  await registerHandler('export.run', (job) => runExport(job.data.exportId))
  await registerHandler('transfers.recover', recoverTransfers)
  await schedule('transfers.recover', '* * * * *', null, { tz: 'UTC' })
  await registerHandler('files.maintenance', () => maintainFiles())
  await schedule('files.maintenance', '10 * * * *', null, { tz: 'UTC' })
  await registerHandler('notifications.emails', () => queueNotificationEmails())
  await registerHandler('notifications.digests', () => queueNotificationDigests())
  await registerHandler('notifications.deliver', (job) => deliverNotificationBatch(job.data.batchId), { concurrency: 3 })
  await registerHandler('notifications.cleanup', () => cleanupNotifications())
  await registerHandler('email.send', sendQueuedEmail, { concurrency: 3 })
  await registerHandler('tokens.cleanup', cleanupExpiredTokens)
  await registerHandler('members.reassign', (job) => reassignRecords(job.data))
  await registerHandler('trial.reminders', () => sendTrialReminders())
  await registerHandler('trial.expire', () => expireTrials())
  await registerHandler('usage.recount', () => recountAllUsage())
  await registerHandler('leads.rescore', () => rescoreAllLeads())
  await registerHandler('records.purge', () => purgeDeletedRecords())
  await registerHandler('deals.rotting_scan', () => scanRottingDeals())
  await registerHandler('tasks.reminders', () => sendDueReminders())
  await registerHandler('tasks.overdue_scan', () => scanOverdueTasks())

  // 02:30 IST daily
  await schedule('tokens.cleanup', '30 2 * * *', null, { tz: 'Asia/Kolkata' })
  // Hourly; each workspace's reminders go out from 09:00 in its own time zone (plan.service.js).
  await schedule('trial.reminders', '5 * * * *', null, { tz: 'UTC' })
  await schedule('trial.expire', '0 * * * *', null, { tz: 'UTC' })
  // 03:15 IST daily — refreshes the usage display cache
  await schedule('usage.recount', '15 3 * * *', null, { tz: 'Asia/Kolkata' })
  // 03:30 IST — lead score decay; 04:00 IST — purge records deleted over 30 days ago
  await schedule('leads.rescore', '30 3 * * *', null, { tz: 'Asia/Kolkata' })
  await schedule('records.purge', '0 4 * * *', null, { tz: 'Asia/Kolkata' })
  // 08:00 IST — rotting deals, so owners hear about them at the start of the day
  await schedule('deals.rotting_scan', '0 8 * * *', null, { tz: 'Asia/Kolkata' })
  // Task reminders every minute; overdue events every 15 minutes
  await schedule('notifications.emails', '* * * * *', null, { tz: 'UTC' })
  await schedule('notifications.digests', '* * * * *', null, { tz: 'UTC' })
  await schedule('notifications.cleanup', '15 4 * * *', null, { tz: 'UTC' })
  await schedule('tasks.reminders', '* * * * *', null, { tz: 'UTC' })
  await schedule('tasks.overdue_scan', '*/15 * * * *', null, { tz: 'UTC' })
}
