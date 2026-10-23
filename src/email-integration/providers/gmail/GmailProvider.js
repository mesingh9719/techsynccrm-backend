import { provider, oauthClient } from '../../../integrations/gmail/provider.js'
import { GOOGLE_EMAIL_SCOPES } from '../../config/googleOAuth.js'

/** @implements {import('../EmailProvider.ts').EmailProvider} */
export class GmailProvider {
  getAuthUrl({ state, nonce, codeChallenge, loginHint }) {
    return oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true,
      login_hint: loginHint, scope: [...GOOGLE_EMAIL_SCOPES], state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256' })
  }
  handleCallback(code, verifier) { return provider.exchange(code, verifier) }
  revoke(token) { return provider.revoke(token) }
  async getValidAccessToken(account) { return (await import('../../../integrations/gmail/jobs.js')).accessToken(account) }
  async sendEmail() { throw new Error('not implemented') }
  async syncInbox() { throw new Error('not implemented') }
}
