// Non-secret browser attempt identifier, covered by the hashed one-use OAuth state.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const validPopupId = (value) => typeof value === 'string' && uuid.test(value)
export function popupIdFromState(state) {
  const parts = typeof state === 'string' ? state.split('.') : []
  return parts.length === 2 && validPopupId(parts[1]) ? parts[1] : undefined
}
