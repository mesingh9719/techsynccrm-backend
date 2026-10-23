/** Connection contract for subsequent send and reply-sync phases. No credentials in public DTOs. */
export type EmailProviderName = 'GMAIL' | 'SMTP' | 'MICROSOFT'
export interface ProviderIdentity { subject: string; email: string; displayName?: string }
export interface ProviderTokens { refresh_token?: string; access_token?: string; id_token?: string; scope?: string; expiry_date?: number }
export interface ConnectedAccount { id: string; organizationId: string; generation: number; credentialEnc: string | null; wrappedKey: string; keyVersion: string }
export interface EmailProvider {
  getAuthUrl(options: { state: string; nonce: string; codeChallenge: string; loginHint: string }): string
  handleCallback(code: string, verifier: string): Promise<ProviderTokens>
  revoke(token: string): Promise<void>
  getValidAccessToken(account: ConnectedAccount): Promise<string>
  sendEmail(): Promise<never>
  syncInbox(): Promise<never>
}
