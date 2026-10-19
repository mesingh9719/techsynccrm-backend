import bcrypt from 'bcryptjs'
import { prisma } from '../db/prisma.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Re-authentication for sensitive actions (change email, 2FA changes, transfer ownership, delete
 * account). Throws a field error on `field` when the password is wrong.
 */
export async function assertPassword(userId, password, field = 'password') {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
  const ok = user && (await bcrypt.compare(password ?? '', user.passwordHash))
  if (!ok) {
    throw new ApiError(400, 'That password is incorrect.', { code: 'INVALID_PASSWORD', details: { fields: { [field]: 'That password is incorrect' } } })
  }
}
