// Vitest setup: TICK_HZ=60 npm test runs the suite at the other simulation rate (default 30).
import { setTickRate } from '../sim/types'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
if (env?.TICK_HZ) setTickRate(Number(env.TICK_HZ))
