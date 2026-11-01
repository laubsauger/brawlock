export function tempDir(prefix: string): string
export function removeDir(dir: string): void
export function writeTestFile(dir: string, name: string, text: string): void
export function gzipBase64(text: string): string
export function gunzipBase64(b64: string): string

export function openTestDatabase(file: string): {
  exec(sql: string): void
  prepare(sql: string): {
    get(...params: (string | number | null)[]): unknown
    all(...params: (string | number | null)[]): unknown[]
    run(...params: (string | number | null)[]): unknown
  }
  close(): void
}
