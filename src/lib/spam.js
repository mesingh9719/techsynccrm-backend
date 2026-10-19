/** Submissions faster than this after the form rendered are treated as bots. */
export const MIN_HUMAN_FILL_MS = 2000

/**
 * Bot check for public forms: the hidden honeypot field was filled, or the form was submitted
 * faster than a person could fill it. `elapsedMs` is optional so older cached pages still work.
 */
export function isSpam({ website, elapsedMs }) {
  return Boolean(website?.trim()) || (typeof elapsedMs === 'number' && elapsedMs < MIN_HUMAN_FILL_MS)
}
