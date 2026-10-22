import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { observeQuery, requestPerformance } from '../../src/lib/performance.js'

describe('request performance metrics', () => {
  it('isolates concurrent requests and never logs SQL or parameters', async () => {
    const logs = [], log = { warn: vi.fn() }
    const responses = await Promise.all([1, 3].map((count) => new Promise((resolve) => {
      const headers = {}, res = new EventEmitter()
      res.setHeader = (key, value) => { headers[key] = value }
      res.writeHead = () => {}
      res.write = () => true
      res.end = () => { res.writeHead(); res.emit('finish'); resolve(headers['Server-Timing']) }
      const req = { id: String(count), log: { info: (entry) => logs.push(entry) } }
      requestPerformance(req, res, async () => {
        for (let i = 0; i < count; i++) {
          await new Promise((done) => setTimeout(done, 1))
          observeQuery({ duration: 3, query: 'secret SQL', params: 'secret params' }, log, 2)
        }
        res.end('{"ok":true}')
      })
    })))
    expect(responses).toEqual([
        expect.stringContaining('db;dur=3.00, queries;desc="1"'), expect.stringContaining('db;dur=9.00, queries;desc="3"'),
      ])
      expect(logs.map((entry) => entry.performance.responseBytes)).toEqual([11, 11])
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret')
  })
})
