/** Error with an HTTP status code. Throw it from controllers/services; the error handler formats it. */
export class ApiError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   * @param {{ code?: string, details?: unknown }} [extra] machine-readable code and optional details
   */
  constructor(statusCode, message, { code, details } = {}) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, message, { code: 'BAD_REQUEST', details })
  }

  static unauthorized(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    return new ApiError(401, message, { code })
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message, { code: 'FORBIDDEN' })
  }

  static notFound(message = 'Not found') {
    return new ApiError(404, message, { code: 'NOT_FOUND' })
  }

  static conflict(message = 'Conflict', field) {
    return new ApiError(409, message, { code: 'CONFLICT', details: field ? { field } : undefined })
  }
}
