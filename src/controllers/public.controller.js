import * as publicService from '../services/public.service.js'

const requestMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) })

export async function submitContact(req, res) {
  res.status(201).json({ success: true, data: await publicService.submitContact(req.body, requestMeta(req)) })
}

export async function getDemoSlots(req, res) {
  res.json({ success: true, data: await publicService.getDemoSlots(req.validated.query.date) })
}

export async function requestDemo(req, res) {
  res.status(201).json({ success: true, data: await publicService.requestDemo(req.body, requestMeta(req)) })
}

export async function subscribeNewsletter(req, res) {
  await publicService.subscribeNewsletter(req.body, requestMeta(req))
  res.json({ success: true, data: { ok: true } })
}

export async function confirmNewsletter(req, res) {
  res.json({ success: true, data: await publicService.confirmNewsletter(req.body.token) })
}

export async function unsubscribeNewsletter(req, res) {
  res.json({ success: true, data: await publicService.unsubscribeNewsletter(req.body.token) })
}

export async function listInbound(req, res) {
  res.json({ success: true, data: await publicService.listInbound(req.validated.query) })
}
