import type { RatingAuthority } from '../src/net/ratingAuthority'
import type { LogFn } from '../src/net/server'

export function remoteRatingAuthority(opts: { url: string; token: string; file: string; log: LogFn; allowInsecureForTests?: boolean; requestMs?: number; retryMs?: number }): RatingAuthority & { pending(): number; flush(): Promise<Map<string, unknown>> }
