/** M11 defaults. Opt-in types start disabled; mandatory types always retain their inbox channel. */
export const NOTIFICATION_TYPES = {
  lead_assigned: { label: 'Lead assigned to you', inApp: true, email: true },
  lead_repeat_enquiry: { label: 'Repeat lead enquiries', inApp: true, email: false },
  new_unassigned_lead: { label: 'New unassigned leads', inApp: false, email: false },
  deal_assigned: { label: 'Deal assigned to you', inApp: true, email: true },
  deal_rotting: { label: 'Idle deals', inApp: true, email: false },
  deal_won: { label: 'Team deals won', inApp: false, email: false },
  task_assigned: { label: 'Task assigned to you', inApp: true, email: true },
  task_reminder: { label: 'Task reminders', inApp: true, email: true, mandatory: true },
  task_overdue: { label: 'Overdue tasks (also in digest)', inApp: false, email: false },
  mention: { label: 'Mentions', inApp: true, email: true, mandatory: true },
  member_joined: { label: 'Invited members joining', inApp: true, email: false },
  import_finished: { label: 'Import results', inApp: true, email: true },
  trial_ending: { label: 'Trial ending', inApp: true, email: true },
  system: { label: 'Workspace announcements', inApp: true, email: false },
}
export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES)
export const NOTIFICATION_CHANNEL = 'techsync_notifications'
export const EMAIL_BATCH_MS = 5 * 60_000
export const GROUP_WINDOW_MS = 10 * 60_000

export function notificationChannels(type, preference) {
  const defaults = NOTIFICATION_TYPES[type]
  if (!defaults) return { inApp: false, email: false }
  return { inApp: defaults.mandatory || (preference?.inApp ?? defaults.inApp), email: preference?.email ?? defaults.email }
}
