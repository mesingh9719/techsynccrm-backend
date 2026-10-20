import { Router } from 'express'
import { requireAuth, requireVerified } from '../middlewares/auth.js'
import { requireStaff } from '../middlewares/staff.js'
import { validate } from '../middlewares/validate.js'
import { auditContext } from '../lib/audit.js'
import {
  organizationIdParamSchema,
  extendTrialSchema,
  setPlanSchema,
} from '../validators/organization.validators.js'
import {
  clientListSchema,
  queryListSchema,
  queryParams,
  messageParams,
  queryStatusSchema,
  queryMessageSchema,
} from '../validators/superadmin.validators.js'
import * as service from '../services/superadmin.service.js'
import * as plans from '../controllers/plan.controller.js'
import { prisma } from '../db/prisma.js'

const router = Router()
router.use(requireAuth, requireStaff, requireVerified)
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})
router.get('/me', async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.user.id },
    select: { id: true, fullName: true, email: true },
  })
  res.json({ success: true, data: { user } })
})
router.get('/overview', async (_req, res) =>
  res.json({ success: true, data: await service.overview() }),
)
router.get('/clients', validate(clientListSchema, 'query'), async (req, res) =>
  res.json({
    success: true,
    data: await service.listClients(req.validated.query),
  }),
)
router.get(
  '/clients/:id',
  validate(organizationIdParamSchema, 'params'),
  async (req, res) =>
    res.json({
      success: true,
      data: await service.clientDetail(req.validated.params.id),
    }),
)
router.post(
  '/clients/:id/plan',
  validate(organizationIdParamSchema, 'params'),
  validate(setPlanSchema),
  plans.setPlan,
)
router.post(
  '/clients/:id/extend-trial',
  validate(organizationIdParamSchema, 'params'),
  validate(extendTrialSchema),
  plans.extendTrial,
)
router.get('/queries', validate(queryListSchema, 'query'), async (req, res) =>
  res.json({
    success: true,
    data: await service.listQueries(req.validated.query),
  }),
)
router.get(
  '/queries/:type/:id',
  validate(queryParams, 'params'),
  async (req, res) => {
    const { type, id } = req.validated.params
    res.json({ success: true, data: await service.queryDetail(type, id) })
  },
)
router.patch(
  '/queries/:type/:id',
  validate(queryParams, 'params'),
  validate(queryStatusSchema),
  async (req, res) => {
    const { type, id } = req.validated.params
    res.json({
      success: true,
      data: await service.updateQueryStatus(
        auditContext(req),
        type,
        id,
        req.body.status,
      ),
    })
  },
)
router.post(
  '/queries/:type/:id/messages',
  validate(queryParams, 'params'),
  validate(queryMessageSchema),
  async (req, res) => {
    const { type, id } = req.validated.params
    res
      .status(201)
      .json({
        success: true,
        data: await service.addQueryMessage(
          auditContext(req),
          type,
          id,
          req.body,
        ),
      })
  },
)
router.post(
  '/queries/:type/:id/messages/:messageId/retry',
  validate(messageParams, 'params'),
  async (req, res) => {
    const { type, id, messageId } = req.validated.params
    res
      .status(202)
      .json({
        success: true,
        data: await service.retryReply(auditContext(req), type, id, messageId),
      })
  },
)
export default router
