import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { pinoHttp } from 'pino-http'
import { env } from './config/env.js'
import { logger } from './lib/logger.js'
import { safeRequestUrl } from './lib/requestUrl.js'
import routes from './routes/index.js'
import { requestId } from './middlewares/requestId.js'
import { requestPerformance } from './lib/performance.js'
import { errorHandler, notFound } from './middlewares/errorHandler.js'

const app = express()

// Trust the first proxy (load balancer / reverse proxy) so req.ip and rate limiting see the client IP.
app.set('trust proxy', 1)
app.disable('x-powered-by')

app.use(requestId)
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.id,
    // Health checks every few seconds would drown everything else.
    autoLogging: { ignore: (req) => req.url === '/api/health' },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: safeRequestUrl(req.url) }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
)
app.use(helmet())
if (env.PERFORMANCE_METRICS) app.use(requestPerformance)
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: ['X-Request-Id', ...(env.PERFORMANCE_METRICS ? ['Server-Timing'] : [])],
  }),
)
app.use(compression({ filter: (req, res) => req.headers.accept?.includes('text/event-stream') ? false : compression.filter(req, res) }))
app.use(express.json({ limit: '1mb', verify: (req, _res, bytes) => {
  if (req.originalUrl.split('?')[0].replace(/\/$/, '') === '/api/webhooks/in/facebook') req.rawBody = Buffer.from(bytes)
} }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))
app.use(cookieParser())

app.use(
  '/api',
  rateLimit({
    // Public provider callbacks have their own burst limits and signature verification.
    skip: (req) => req.path.replace(/\/$/, '') === '/webhooks/in/facebook' || /^\/integrations\/facebook\/(?:data-deletion(?:\/status\/[^/]+)?|deauthorize)\/?$/.test(req.path),
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
  routes,
)

app.use(notFound)
app.use(errorHandler)

export default app
