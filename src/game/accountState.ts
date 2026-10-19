import { create } from 'zustand'
import type { AccountPlayer } from './account'

interface AccountState {
  player: AccountPlayer | null
  loaded: boolean
  error: string | null
}

/** Memory only: browser storage never proves an authenticated account. */
export const useAccount = create<AccountState>(() => ({ player: null, loaded: false, error: null }))
