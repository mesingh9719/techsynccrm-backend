/**
 * Event subscribers. Modules register handlers at worker start-up (see events/subscribers/index.js):
 *
 *   subscribe('timeline', ['lead.*', 'deal.stage_changed'], async (event) => { ... })
 *
 * Delivery is at-least-once: a handler may see the same event again after a failure or a worker
 * restart, so handlers must be idempotent (key on `event.id`).
 */

const subscribers = []

/**
 * @param {string} name unique subscriber name (used in logs)
 * @param {string[]} patterns event types; "lead.*" matches every lead event, "*" matches all
 * @param {(event: { id: string, organizationId: string|null, type: string, entityType: string, entityId: string, actorId: string|null, payload: object, createdAt: Date }) => Promise<void>} handler
 */
export function subscribe(name, patterns, handler) {
  if (subscribers.some((s) => s.name === name)) throw new Error(`Subscriber "${name}" is already registered`)
  subscribers.push({ name, patterns, handler })
}

const matches = (pattern, type) => pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)))

export function subscribersFor(type) {
  return subscribers.filter((s) => s.patterns.some((p) => matches(p, type)))
}

/** For tests only. */
export function clearSubscribers() {
  subscribers.length = 0
}
