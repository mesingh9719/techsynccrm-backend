import { Files } from 'files-sdk'
import { neon } from 'files-sdk/neon'
import { env } from '../config/env.js'

/**
 * Neon Object Storage client (S3-compatible, branch-scoped).
 * The adapter reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3
 * and AWS_REGION from the environment that `neon deploy` / `neon env pull` populate.
 */
export const storage = new Files({
  adapter: neon({ bucket: env.STORAGE_BUCKET, defaultUrlExpiresIn: env.STORAGE_URL_EXPIRES_IN }),
})
