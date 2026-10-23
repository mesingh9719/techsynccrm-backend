export function googleAuthEnvironment(source = process.env) {
  const dedicated = Boolean(source.GOOGLE_AUTH_CLIENT_ID || source.GOOGLE_AUTH_CLIENT_SECRET)
  return {
    GOOGLE_AUTH_ENABLED: source.GOOGLE_AUTH_ENABLED !== 'false',
    GOOGLE_AUTH_CLIENT_ID: (dedicated ? source.GOOGLE_AUTH_CLIENT_ID : source.GOOGLE_CLIENT_ID) || '',
    GOOGLE_AUTH_CLIENT_SECRET: (dedicated ? source.GOOGLE_AUTH_CLIENT_SECRET : source.GOOGLE_CLIENT_SECRET) || '',
    GOOGLE_AUTH_REDIRECT_URI: source.GOOGLE_AUTH_REDIRECT_URI || (source.NODE_ENV === 'production' ? '' : `http://localhost:${source.PORT || 5000}/api/auth/google/callback`),
  }
}
