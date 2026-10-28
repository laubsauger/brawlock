export interface ChatSpeaker {
  id: string
  profile: { name: string; color: number | null } | null
}
export interface ChatOptions {
  origin: string
  /** keys the opaque sender handles; the account service's own secret */
  secret: string
  speaker: (request: Request) => Promise<ChatSpeaker | null>
  feedback?: { note(accountId: string, message: string): string } | null
  /** Exact HTTPS origins embedding the client (itch.io): read only. */
  embeds?: string[]
  now?: () => number
  waitMs?: number
}
export function openChat(file: string, options: ChatOptions): {
  handler(request: Request): Promise<Response>
  admin(request: Request): Promise<Response>
  close(): void
}
