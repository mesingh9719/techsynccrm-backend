/**
 * Every pg-boss queue and its retry policy. Queues must exist before jobs can be sent to them, so
 * both the API and the worker create any missing ones at start-up. Add new queues here.
 *
 * Default policy: 5 retries with exponential backoff from 30 s, capped at 15 minutes; failed jobs
 * are kept 14 days for inspection.
 */
const standard = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  deleteAfterSeconds: 14 * 24 * 3600,
}

export const QUEUES = {
  // Recovery is driven by durable state; never let pg-boss blindly retry a possible send.
  'gmail.send': { ...standard, retryLimit: 0, expireInSeconds: 120 },
  'gmail.sync': { ...standard, retryLimit: 0, expireInSeconds: 180 },
  'gmail.maintain': { ...standard, retryLimit: 0, expireInSeconds: 180 },
  'facebook.delete': { ...standard, retryLimit: 0, expireInSeconds: 180 },
  'facebook.privacy_recover': { ...standard, expireInSeconds: 120 },
  'facebook.lead': { ...standard, retryLimit: 0, expireInSeconds: 90 },
  'facebook.sync': { ...standard, retryLimit: 0, expireInSeconds: 180 },
  'facebook.recover': { ...standard, expireInSeconds: 120 },
  'import.preview': { ...standard, expireInSeconds: 7200 },
  'import.run': { ...standard, expireInSeconds: 7200 },
  'export.run': { ...standard, expireInSeconds: 1800 },
  'transfers.recover': { ...standard, expireInSeconds: 120 },
  'files.maintenance': { ...standard, expireInSeconds: 600 },
  'email.send': { ...standard, expireInSeconds: 120 },
  'tokens.cleanup': { ...standard, retryLimit: 2 },
  'members.reassign': { ...standard, expireInSeconds: 600 },
  // M06 — idempotent, so a retry never double-sends or double-downgrades
  'trial.reminders': { ...standard, retryLimit: 2, expireInSeconds: 900 },
  'trial.expire': { ...standard, retryLimit: 2, expireInSeconds: 900 },
  'usage.recount': { ...standard, retryLimit: 2, expireInSeconds: 1800 },
  // M07/M08
  'leads.rescore': { ...standard, retryLimit: 2, expireInSeconds: 3600 },
  'records.purge': { ...standard, retryLimit: 2, expireInSeconds: 3600 },
  // M09
  'deals.rotting_scan': { ...standard, retryLimit: 2, expireInSeconds: 1800 },
  // M10 — short-lived scans; a missed run is caught by the next one
  'notifications.emails': { ...standard, expireInSeconds: 120 },
  'notifications.digests': { ...standard, expireInSeconds: 300 },
  'notifications.deliver': { ...standard, expireInSeconds: 120 },
  'notifications.cleanup': { ...standard, expireInSeconds: 600 },
  'tasks.reminders': { ...standard, retryLimit: 0, expireInSeconds: 120, deleteAfterSeconds: 3600 },
  'tasks.overdue_scan': { ...standard, retryLimit: 1, expireInSeconds: 600, deleteAfterSeconds: 24 * 3600 },
}
