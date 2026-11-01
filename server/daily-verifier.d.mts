export class VerifierBusy extends Error {}
export function createVerifierPool(dir: string, options?: { keep?: number; timeoutMs?: number; queueMax?: number }): {
  ids(): string[]
  run(id: string, input: { day: number; salt: number; tape: unknown }): Promise<unknown>
}
