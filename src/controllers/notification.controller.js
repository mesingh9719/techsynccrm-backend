import * as notifications from '../services/notification.service.js'
import { openNotificationStream } from '../realtime/notifications.js'
const ok = (res, data) => res.json({ success: true, data })
export async function list(req, res) { ok(res, await notifications.listNotifications(req.ctx, req.validated.query)) }
export async function count(req, res) { ok(res, { unreadCount: await notifications.unreadCount(req.ctx) }) }
export async function read(req, res) { await notifications.markNotificationRead(req.ctx, req.validated.params.id); ok(res, { read: true }) }
export async function readAll(req, res) { await notifications.markAllNotificationsRead(req.ctx); ok(res, { read: true }) }
export async function ticket(req, res) { ok(res, await notifications.createStreamTicket(req.ctx)) }
export async function stream(req, res) { await openNotificationStream(req, res) }
export async function preferences(req, res) { ok(res, await notifications.getNotificationPreferences(req.ctx)) }
export async function updatePreferences(req, res) { ok(res, await notifications.updateNotificationPreferences(req.ctx, req.body)) }
