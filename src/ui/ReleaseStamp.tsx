declare const __RELEASE__: { version: string; releaseDate: string; tag: string }
declare const __BUILD_ID__: string

const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(__RELEASE__.releaseDate))

export function ReleaseStamp() {
  return <span className="text-xs text-ash whitespace-nowrap" title={`Build ${__BUILD_ID__}`} aria-label="Game version">
    {__RELEASE__.tag} · <time dateTime={__RELEASE__.releaseDate}>{date}</time>
    {import.meta.env.DEV && ' · dev'}
  </span>
}
