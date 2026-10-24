import * as forms from '../services/webForm.service.js'

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })
const requestMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) })

export const list = async (req, res) => ok(res, { forms: await forms.listForms(req.ctx) })
export const getOne = async (req, res) => ok(res, { form: await forms.getForm(req.ctx, req.validated.params.id) })
export const create = async (req, res) => ok(res, { form: await forms.createForm(req.ctx, req.body) }, 201)
export const update = async (req, res) => ok(res, { form: await forms.updateForm(req.ctx, req.validated.params.id, req.body) })
export async function remove(req, res) {
  await forms.deleteForm(req.ctx, req.validated.params.id)
  res.status(204).end()
}
export const submissions = async (req, res) => ok(res, { items: await forms.listSubmissions(req.ctx, req.validated.params.id, req.validated.query) })
export const embedCode = async (req, res) => ok(res, await forms.getEmbedCode(req.ctx, req.validated.params.id))

// Public (no session): the hosted page /f/:key and the embed iframe.
export async function getPublic(req, res) {
  res.set('Cache-Control', 'no-store')
  ok(res, await forms.getPublicForm(req.validated.params.key))
}
export async function view(req, res) {
  await forms.recordView(req.validated.params.key)
  res.status(204).end()
}
export const submit = async (req, res) => ok(res, await forms.submitPublicForm(req.validated.params.key, req.body, requestMeta(req)), 201)
