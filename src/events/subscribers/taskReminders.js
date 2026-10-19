import { subscribe } from '../registry.js'
import { deliverTaskReminder } from '../../services/task.service.js'

subscribe('task-reminders', ['task.reminder_due'], deliverTaskReminder)
