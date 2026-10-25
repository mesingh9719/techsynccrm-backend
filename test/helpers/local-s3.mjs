// Disposable in-memory S3 subset for browser QA only. Uses no real storage credentials.
// Run beside scripts/product-review-qa.js with QA_LOCAL_S3=true. Objects vanish on exit.
import http from 'node:http'
import crypto from 'node:crypto'
const objects = new Map()
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:5062')
  const key = decodeURIComponent(url.pathname)
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5181')
  if (req.method === 'PUT') {
    const chunks = []; let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 26 * 1024 ** 2) { res.writeHead(413).end(); return }
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks), etag = `"${crypto.createHash('md5').update(bytes).digest('hex')}"`
    objects.set(key, { bytes, etag, type: req.headers['content-type'] })
    res.setHeader('ETag', etag); res.writeHead(200).end(); return
  }
  if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return }
  const object = objects.get(key)
  if (!object) { res.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>'); return }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return }
  res.setHeader('Content-Length', object.bytes.length)
  res.setHeader('ETag', object.etag)
  res.setHeader('Content-Type', url.searchParams.get('response-content-type') || object.type || 'application/octet-stream')
  const disposition = url.searchParams.get('response-content-disposition')
  if (disposition) res.setHeader('Content-Disposition', disposition)
  res.writeHead(200).end(req.method === 'HEAD' ? undefined : object.bytes)
})
server.listen(5062, '127.0.0.1', () => console.log('Disposable S3 HTTP stub: http://127.0.0.1:5062'))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
