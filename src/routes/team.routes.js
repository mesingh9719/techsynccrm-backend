import { Router } from 'express'
import * as team from '../controllers/team.controller.js'
import { permit, requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import {
  createInvitationsSchema,
  createTeamSchema,
  deactivateMemberSchema,
  idParams,
  listMembersQuery,
  memberOptionsQuery,
  updateMemberSchema,
  updateTeamSchema,
  userIdParams,
} from '../validators/team.validators.js'

/** Members (/api/members), invitations (/api/invitations) and teams (/api/teams) of the current workspace. */

export const memberRoutes = Router()
memberRoutes.use(requireOrg)
memberRoutes.get('/', validate(listMembersQuery, 'query'), team.listMembers)
memberRoutes.get('/options', validate(memberOptionsQuery, 'query'), team.memberOptions)
memberRoutes.patch('/:userId', permit('members.manage'), validate(userIdParams, 'params'), validate(updateMemberSchema), team.updateMember)
memberRoutes.post('/:userId/deactivate', permit('members.manage'), validate(userIdParams, 'params'), validate(deactivateMemberSchema), team.deactivateMember)
memberRoutes.post('/:userId/reactivate', permit('members.manage'), validate(userIdParams, 'params'), team.reactivateMember)

export const invitationRoutes = Router()
invitationRoutes.use(requireOrg, permit('members.invite'))
invitationRoutes.get('/', team.listInvitations)
invitationRoutes.post('/', validate(createInvitationsSchema), team.createInvitations)
invitationRoutes.post('/:id/resend', validate(idParams, 'params'), team.resendInvitation)
invitationRoutes.delete('/:id', validate(idParams, 'params'), team.revokeInvitation)

export const teamRoutes = Router()
teamRoutes.use(requireOrg)
teamRoutes.get('/', team.listTeams)
teamRoutes.post('/', permit('members.manage'), validate(createTeamSchema), team.createTeam)
teamRoutes.patch('/:id', permit('members.manage'), validate(idParams, 'params'), validate(updateTeamSchema), team.updateTeam)
teamRoutes.delete('/:id', permit('members.manage'), validate(idParams, 'params'), team.deleteTeam)
