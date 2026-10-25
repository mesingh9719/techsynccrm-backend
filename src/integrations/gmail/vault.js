import crypto from 'node:crypto'
import { provider } from './provider.js'
import { sealValue, openValue } from '../google/envelope.js'

export async function newEnvelope() {
  const key = crypto.randomBytes(32)
  return { key, ...(await provider.wrapKey(key)) }
}
export function seal(key, account, purpose, value) {
  return sealValue(key, `${account.organizationId}:${account.id}`, purpose, value)
}
export function open(key, account, purpose, value) {
  return openValue(key, `${account.organizationId}:${account.id}`, purpose, value)
}
