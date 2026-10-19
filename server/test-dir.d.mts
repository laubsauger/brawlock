export function tempDir(prefix: string): string
export function removeDir(dir: string): void

export function openTestDatabase(file: string): {
  exec(sql: string): void
  prepare(sql: string): {
    get(...params: (string | number | null)[]): unknown
    all(...params: (string | number | null)[]): unknown[]
    run(...params: (string | number | null)[]): unknown
  }
  close(): void
}
