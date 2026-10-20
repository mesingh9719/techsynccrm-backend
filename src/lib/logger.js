import pino from 'pino'

const isProduction = process.env.NODE_ENV === 'production'

/**
 * Structured logger shared by the API and the worker. JSON in production, pretty in development.
 * Secrets are redacted wherever they might appear in a logged object.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  base: { service: process.env.SERVICE_NAME ?? 'api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.accessToken',
      '*.access_token',
      '*.signedRequest',
      '*.signed_request',
      '*.nonce',
      '*.confirmation_code',
      '*.refreshToken',
      '*.otp',
      '*.code',
    ],
    censor: '[redacted]',
  },
  ...(!isProduction && {
    transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } },
  }),
})
