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
