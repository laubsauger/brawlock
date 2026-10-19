/** Regional operator state; normal room hosts cannot change it. */
export interface MaintenanceState {
  draining: boolean
  message: string | null
}

export const MAINTENANCE_NOTICE = 'This region is preparing an update. Current matches can finish; new games are paused.'

export interface MaintenanceStatus extends MaintenanceState {
  rooms: number
  players: number
  connections: number
  activeMatches: number
  waitingRooms: number
  creatingRooms: number
  pendingResults: number
  pendingRatings: number
  pendingRewards: number
  pendingReleases: number
  ready: boolean
}

export interface MaintenanceStore {
  get(): MaintenanceState
  set(state: MaintenanceState): void
  close(): void
}

export function validMaintenance(value: unknown): value is MaintenanceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return Object.keys(state).length === 2 && typeof state.draining === 'boolean'
    && (state.message === null || typeof state.message === 'string' && state.message.length > 0 && state.message.length <= 160 && !/[\u0000-\u001f\u007f-\u009f]/.test(state.message))
    && (state.draining || state.message === null)
}
