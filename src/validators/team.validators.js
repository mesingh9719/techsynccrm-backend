import { z } from 'zod'
import { ASSIGNABLE_ROLES } from '../config/permissions.js'

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254)
const role = z.enum(ASSIGNABLE_ROLES, { error: 'Choose a role' })
const uuidList = z.array(z.uuid('Invalid team')).max(50)

export const userIdParams = z.object({ userId: z.uuid('Invalid member') })
export const idParams = z.object({ id: z.uuid('Invalid id') })
export const tokenParams = z.object({ token: z.string().trim().min(20, 'Invalid link').max(200, 'Invalid link') })

export const listMembersQuery = z.object({
  status: z.enum(['active', 'deactivated', 'all']).default('active'),
  q: z.string().trim().max(100).optional(),
})

export const memberOptionsQuery = z.object({ q: z.string().trim().max(100).optional() })

export const updateMemberSchema = z
  .object({
    role,
    title: z.string().trim().max(60).nullish().transform((v) => v || null),
    teamIds: uuidList,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

export const deactivateMemberSchema = z.object({ reassignToUserId: z.uuid('Choose who takes over their records') })

export const createInvitationsSchema = z.object({
  emails: z.array(email).min(1, 'Add at least one email').max(20, 'Invite up to 20 people at a time'),
  role,
  teamIds: uuidList.optional().default([]),
})

export const acceptInvitationSchema = z.object({ token: z.string().trim().min(20, 'Invalid link').max(200, 'Invalid link') })

export const signupWithInviteSchema = z.object({
  token: z.string().trim().min(20, 'Invalid link').max(200, 'Invalid link'),
  fullName: z.string().trim().min(2, 'Enter at least 2 characters').max(60),
  password: z
    .string()
    .min(8, 'Use at least 8 characters')
    .max(72, 'Use at most 72 characters')
    .regex(/[A-Za-z]/, 'Include at least one letter')
    .regex(/[0-9]/, 'Include at least one number'),
  jobRole: z.string().trim().max(60).optional(),
  acceptTerms: z.literal(true, { error: 'You need to accept the terms to continue' }),
})

const teamMembers = z.array(z.object({ userId: z.uuid('Invalid member'), isManager: z.boolean().default(false) })).max(500)

export const createTeamSchema = z.object({
  name: z.string().trim().min(2, 'Enter a team name').max(60, 'Keep it under 60 characters'),
  members: teamMembers.default([]),
})

export const updateTeamSchema = z
  .object({ name: z.string().trim().min(2, 'Enter a team name').max(60, 'Keep it under 60 characters'), members: teamMembers })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
