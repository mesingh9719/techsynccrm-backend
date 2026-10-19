import crypto from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Gives every request an id (honouring an incoming X-Request-Id only if it is a UUID, so the
 * header can't be used to inject arbitrary text into logs) and echoes it in the response.
 */
export function requestId(req, res, next) {
  const incoming = req.get('x-request-id')
  req.id = incoming && UUID.test(incoming) ? incoming : crypto.randomUUID()
  res.setHeader('X-Request-Id', req.id)
  next()
}
