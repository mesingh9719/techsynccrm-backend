import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

const requests = new AsyncLocalStorage()

/** Query events contain sensitive SQL/params: retain only counts and durations. */
export function observeQuery(event, log, slowQueryMs = 250) {
  const metrics = requests.getStore()
  if (metrics && !metrics.finished) {
    metrics.queries++
    metrics.dbMs += event.duration
  }
  if (event.duration >= slowQueryMs) {
    log.warn({ durationMs: event.duration, requestId: metrics?.requestId }, 'slow database query')
  }
}

/** Measure fresh JWT/RBAC checks without retaining user, tenant or token data. */
export function measureAuth(fn) {
  const metrics = requests.getStore()
  if (!metrics) return fn()
  const started = performance.now()
  const done = () => { metrics.authMs += performance.now() - started }
  try {
    const result = fn()
    if (result && typeof result.then === 'function') return result.finally(done)
    done()
    return result
  } catch (error) {
    done()
    throw error
  }
}

/** Sum of query durations can exceed wall time when queries overlap. No response data is cached. */
export function requestPerformance(req, res, next) {
  const metrics = { requestId: req.id, started: performance.now(), queries: 0, dbMs: 0, authMs: 0, bytes: 0, finished: false }
  const writeHead = res.writeHead
  const write = res.write
  const end = res.end
  const size = (chunk, encoding) => chunk == null ? 0 : typeof chunk === 'string'
    ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined) : chunk.byteLength
  res.writeHead = function (...args) {
    if (!this.headersSent) this.setHeader('Server-Timing', `app;dur=${(performance.now() - metrics.started).toFixed(2)}, db;dur=${metrics.dbMs.toFixed(2)}, queries;desc="${metrics.queries}", auth;dur=${metrics.authMs.toFixed(2)}`)
    return writeHead.apply(this, args)
  }
  res.write = function (chunk, encoding, ...args) {
    metrics.bytes += size(chunk, encoding)
    return write.call(this, chunk, encoding, ...args)
  }
  res.end = function (chunk, encoding, ...args) {
    metrics.bytes += size(chunk, encoding)
    return end.call(this, chunk, encoding, ...args)
  }
  res.once('finish', () => {
    metrics.finished = true
    req.log?.info({ performance: { method: req.method, route: req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched', totalMs: performance.now() - metrics.started, authMs: metrics.authMs, dbMs: metrics.dbMs, queries: metrics.queries, responseBytes: metrics.bytes } }, 'request performance')
  })
  requests.run(metrics, next)
}
