import * as industryService from '../services/industry.service.js'

/** GET /api/meta/industries — the industry master list (public; cached by browsers for 5 minutes). */
export async function list(_req, res) {
  res.set('Cache-Control', 'public, max-age=300')
  res.json({ success: true, data: { industries: await industryService.listIndustries() } })
}
