export interface IceCredentials {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[]
  expiresAt: number
}
export function turnCredentialIssuer(opts: { secret: string; urls: string[]; ttlSeconds?: number; now?: () => number; randomId?: () => string }): () => IceCredentials
export function iceCredentialEndpoint(opts: { issue?: (() => IceCredentials) | null; allowedOrigins: string[] | null; now?: () => number }): {
  handle(req: { method: string; origin: string | null; ip: string }): { status: number; headers: Record<string, string>; body: unknown }
  sweep(): void
}
