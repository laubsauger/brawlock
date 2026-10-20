export interface FeedbackOptions {
  origin: string
  token: string
  getAccount?: (request: Request) => Promise<{ id: string } | null>
  now?: () => number
}
export function openFeedback(file: string, options: FeedbackOptions): {
  handler(request: Request): Promise<Response>
  close(): void
}
