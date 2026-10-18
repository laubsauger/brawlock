/** Only a join that is still pending may survive chunk-recovery reloads. */
export const PENDING_ROOM_KEY = 'brawlock.pendingRoom'
export function rememberPendingRoom(code: string): void {
  try { sessionStorage.setItem(PENDING_ROOM_KEY, code) } catch { /* storage may be disabled */ }
}
export function clearPendingRoom(code?: string): void {
  try {
    if (code === undefined || sessionStorage.getItem(PENDING_ROOM_KEY) === code) sessionStorage.removeItem(PENDING_ROOM_KEY)
  } catch { /* storage may be disabled */ }
}
