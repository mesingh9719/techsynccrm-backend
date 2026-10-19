import { subscribe } from '../registry.js'
import { handleNotificationEvent } from '../../services/notification.service.js'

subscribe('notifications', ['lead.created', 'lead.assigned', 'lead.repeat_enquiry', 'deal.assigned', 'deal.rotting', 'deal.won', 'task.assigned', 'task.reminder_due', 'task.overdue', 'mention.created', 'member.joined', 'import.completed', 'import.failed', 'trial.ending', 'notification.announced'], handleNotificationEvent)
