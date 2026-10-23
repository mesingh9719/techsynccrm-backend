import { redactEmailSecrets } from '../email-integration/redaction.js'
import pino from 'pino'

const isProduction = process.env.NODE_ENV === 'production'

/**
 * Structured logger shared by the API and the worker. JSON in production, pretty in development.
 * Secrets are redacted wherever they might appear in a logged object.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  base: { service: process.env.SERVICE_NAME ?? 'api' },
  formatters: { log: redactEmailSecrets },
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
      '*.refresh_token',
      '*.credentialEnc',
      '*.bodyHtml',
      '*.bodyText',
      '*.raw',
      '*.id_token',
      '*.client_secret',
      '*.otp',
      '*.code', '*.state', '*.codeVerifier', '*.verifierEnc', '*.wrappedKey',
      '*.refreshTokenCiphertext', '*.refreshTokenIv', '*.refreshTokenAuthTag',
      'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'code', 'state',
      'authorization', '*.authorization', 'req.query', 'req.body', 'err.config', 'err.response.config',
    ],
    censor: '[redacted]',
  },
  ...(!isProduction && {
    transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } },
  }),
})
