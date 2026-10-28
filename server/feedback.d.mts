export interface FeedbackOptions {
  origin: string
  token: string
  getAccount?: (request: Request) => Promise<{ id: string } | null>
  now?: () => number
  /** Exact HTTPS origins embedding the client (itch.io): reports without the session. */
  embeds?: string[]
}
export function openFeedback(file: string, options: FeedbackOptions): {
  handler(request: Request): Promise<Response>
  /** files a report from the service itself (kind 'chat'); returns its id */
  note(accountId: string, message: string): string
  mailBatch(): { id: string; at: number; kind: string; message: string }[]
  mailDelivery(build: (reports: { id: string; at: number; kind: string; message: string }[]) => { from: string; to: string[]; subject: string; text: string }): { key: string; payload: string } | null
  completeMail(key: string): void
  lastMailedAt(): number | null
  markMailed(ids: string[]): void
  mailPending(): number
  close(): void
}
