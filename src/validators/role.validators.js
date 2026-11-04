import { z } from 'zod'
import { ROLE_COLORS } from '../services/role.service.js'

/** Roles (RBAC). Permission strings are checked against the module catalogue in the service. */

const permissions = z.array(z.string().trim().min(1).max(80)).max(300, 'Too many permissions')
const version = z.number({ error: 'Refresh and try again' }).int().min(0)
const name = z.string().trim().min(2, 'Enter at least 2 characters').max(40, 'Keep it under 40 characters')
const description = z.string().trim().max(160, 'Keep it under 160 characters').nullish().transform((v) => v || null)
const color = z.enum(ROLE_COLORS, { error: 'Choose a colour' }).nullable()
/** A built-in role key (`viewer`) or a custom role id. */
const roleRef = z.string().trim().min(1).max(64)

export const roleIdParams = z.object({ id: roleRef })

export const createRoleSchema = z.object({
  name,
  description: description.optional(),
  color: color.optional(),
  copyFrom: roleRef.nullish(),
  permissions: permissions.optional(),
})

export const updateRoleSchema = z
  .object({ name: name.optional(), description: description.optional(), color: color.optional(), permissions: permissions.optional(), expectedVersion: version })
  .refine((v) => ['name', 'description', 'color', 'permissions'].some((k) => v[k] !== undefined), 'Nothing to update')

export const resetRoleSchema = z.object({ expectedVersion: version })

export const deleteRoleSchema = z.object({ reassignTo: roleRef })

export const previewRoleSchema = z.object({ roleId: roleRef, permissions })
