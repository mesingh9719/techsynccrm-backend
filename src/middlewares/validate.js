import { ApiError } from '../utils/ApiError.js'

/**
 * Validates `req[source]` against a zod schema and replaces it with the parsed value.
 * Errors come back as 400 with per-field messages: { field: message }.
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source] ?? {})
    if (!result.success) {
      const fields = {}
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_'
        fields[key] ??= issue.message
      }
      return next(new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: { fields } }))
    }
    if (source === 'body') req.body = result.data
    else req.validated = { ...req.validated, [source]: result.data }
    next()
  }
}
