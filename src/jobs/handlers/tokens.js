import { prisma } from '../../db/prisma.js'

const RETAIN_AFTER_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000

/**
 * `tokens.cleanup` (nightly): deletes refresh tokens and emailed single-use tokens that expired
 * more than 30 days ago. Recent ones are kept so reuse detection and "link expired" messages work.
 */
export async function cleanupExpiredTokens() {
  const cutoff = new Date(Date.now() - RETAIN_AFTER_EXPIRY_MS)
  const [refresh, userTokens] = await prisma.$transaction([
    prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    prisma.userToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
  ])
  return { refreshTokensDeleted: refresh.count, userTokensDeleted: userTokens.count }
}
