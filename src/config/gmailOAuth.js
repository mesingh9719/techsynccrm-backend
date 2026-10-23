/** Resolve server-only OAuth credentials without mixing two different clients. */
export function gmailOAuthEnvironment(source = process.env) {
  const dedicated = Boolean(source.GOOGLE_GMAIL_CLIENT_ID || source.GOOGLE_GMAIL_CLIENT_SECRET)
  return {
    GOOGLE_GMAIL_CLIENT_ID: (dedicated ? source.GOOGLE_GMAIL_CLIENT_ID : source.GOOGLE_CLIENT_ID) || '',
    GOOGLE_GMAIL_CLIENT_SECRET: (dedicated ? source.GOOGLE_GMAIL_CLIENT_SECRET : source.GOOGLE_CLIENT_SECRET) || '',
    // Never infer a public callback from an incoming Host header or the frontend's origin.
    GOOGLE_GMAIL_REDIRECT_URI: source.GOOGLE_GMAIL_REDIRECT_URI || source.GOOGLE_REDIRECT_URI ||
      (source.NODE_ENV === 'production' ? '' : `http://localhost:${source.PORT || 5000}/api/integrations/gmail/callback`),
  }
}
