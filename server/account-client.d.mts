import type { RankedAccountAuthority } from '../src/net/accounts'
import type { LogFn } from '../src/net/server'
export function regionalAccounts(opts: { url: string; token: string; region: string; log: LogFn; rewardFile?: string; requestMs?: number; allowInsecureForTests?: boolean }): RankedAccountAuthority & { register(): Promise<void> }
