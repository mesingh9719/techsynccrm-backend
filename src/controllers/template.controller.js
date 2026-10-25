import * as service from '../services/template.service.js'
import * as rendering from '../services/templateRendering.service.js'

export async function variables(req, res) {
  res.json({ success: true, data: { fields: await rendering.variableCatalogue(req.ctx, req.validated.query.recordType) } })
}
export async function render(req, res) {
  res.json({ success: true, data: await rendering.renderTemplate(req.ctx, req.params.id, req.body) })
}
export async function preview(req, res) {
  res.json({ success: true, data: await rendering.previewTemplate(req.ctx, req.body) })
}

export async function list(req, res) {
  res.json({ success: true, data: await service.listTemplates(req.ctx, req.validated.query) })
}
export async function create(req, res) {
  res.status(201).json({ success: true, data: { template: await service.saveTemplate(req.ctx, req.body) } })
}
export async function update(req, res) {
  res.json({ success: true, data: { template: await service.saveTemplate(req.ctx, req.body, req.params.id) } })
}
