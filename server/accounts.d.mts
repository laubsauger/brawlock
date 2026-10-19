import type { BetterAuthOptions } from 'better-auth'
export interface AccountConfig {
  file: string
  origin: string
  secret: string
  providers: Partial<Record<'google' | 'discord' | 'microsoft', { clientId: string; clientSecret: string }>>
  migrate?: boolean
  regionsToken?: string
}
export function accountName(raw: unknown): { name: string; key: string } | null
export function accountOptions(opts: Omit<AccountConfig, 'file' | 'migrate'> & { database: unknown }): BetterAuthOptions
export function openAccounts(opts: AccountConfig): Promise<{
  auth: ReturnType<typeof import('better-auth').betterAuth>
  handler(request: Request): Promise<Response>
  close(): void
}>
