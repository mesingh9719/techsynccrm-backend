export const connectionStatus = (row) => !row || ['disconnected', 'deleting'].includes(row.status) ? 'DISCONNECTED'
  : row.status === 'reconnect_required' ? 'NEEDS_RECONNECT' : ['connected', 'syncing', 'delayed'].includes(row.status) ? 'CONNECTED' : 'ERROR'

// Explicit allowlist: credentials, wrapped keys and scope tokens never reach API responses.
export function accountDto(row) {
  return row ? { id: row.id, userId: row.userId, provider: 'GMAIL', emailAddress: row.email,
    displayName: row.displayName, status: connectionStatus(row), connectedAt: row.connectedAt || row.consentAt,
    lastUsedAt: row.lastUsedAt, lastErrorAt: row.lastErrorAt, lastError: row.lastError,
    disconnectedAt: row.disconnectedAt, createdAt: row.createdAt } : null
}
export const accountMetadata = { id: true, userId: true, email: true, displayName: true, status: true,
  connectedAt: true, consentAt: true, lastUsedAt: true, lastError: true, lastErrorAt: true, disconnectedAt: true, createdAt: true }
