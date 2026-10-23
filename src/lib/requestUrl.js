/** Remove callback credentials and bearer status codes before request URLs reach logs. */
export function safeRequestUrl(value) {
  if (typeof value !== 'string') return value
  const path = value.split('?')[0]
  if (/(?:^|\/)data-deletion\/status\//i.test(path)) return '/api/integrations/facebook/data-deletion/status/[redacted]'
  if (/^\/api\/(?:notifications\/stream|integrations\/gmail\/callback|integrations\/facebook\/(?:callback|data-deletion|deauthorize)|webhooks\/in\/facebook)\/?$/i.test(path)) return path
  if (/[?&](?:code|state|access_token|input_token|signed_request|hub\.verify_token)=/i.test(value)) return path
  return value
}
