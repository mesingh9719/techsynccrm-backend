import multer from 'multer'
import { env } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { safeRequestUrl } from '../lib/requestUrl.js'

/** 404 for any route that wasn't matched. */
export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`))
}

function normalise(err) {
  if (err instanceof ApiError) return err
  if (err.code === 'P2028' && /expired transaction|transaction.*expired/i.test(err.message)) {
    return new ApiError(503, 'The database took too long to save this change. Please try again.', { code: 'TRANSACTION_TIMEOUT' })
  }
  // Malformed JSON body from express.json()
  if (err instanceof SyntaxError && 'body' in err) return ApiError.badRequest('Invalid JSON body')
  if (err instanceof multer.MulterError) {
    return err.code === 'LIMIT_FILE_SIZE'
      ? new ApiError(413, `File is larger than ${env.MAX_UPLOAD_MB} MB`, { code: 'FILE_TOO_LARGE' })
      : ApiError.badRequest(err.message)
  }
  const status = err.status ?? err.statusCode
  if (status && status < 500) return new ApiError(status, err.message)
  return null
}

/** Central error handler: consistent JSON shape, no internals leaked in production. */
export function errorHandler(err, req, res, _next) {
  const known = normalise(err)
  const statusCode = known?.statusCode ?? 500

  const safeUrl = safeRequestUrl(req.originalUrl)
  if (!known) (req.log ?? console).error({ err }, `unhandled error on ${req.method} ${safeUrl}`)
  else if (known.code === 'TRANSACTION_TIMEOUT') (req.log ?? console).warn({ err }, `transaction timed out on ${req.method} ${safeUrl}`)

  res.status(statusCode).json({
    success: false,
    error: {
      message: known ? known.message : env.isProduction ? 'Internal server error' : err.message,
      ...(known?.code && { code: known.code }),
      ...(known?.details && { details: known.details }),
      ...(!known && !env.isProduction && { stack: err.stack }),
    },
  })
}
