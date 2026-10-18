/** Browser media/visibility surface for streaming music lifecycle tests. */
export class MockMedia extends EventTarget {
  static instances: MockMedia[] = []
  readonly loaded: string[] = []
  preload = ''
  readyState = 0
  paused = true
  ended = false
  currentTime = 0
  error: MediaError | null = null
  plays = 0
  pauses = 0
  private url = ''
  constructor() { super(); MockMedia.instances.push(this) }
  get src() { return this.url }
  set src(value: string) { this.url = value; this.ended = false; this.paused = true; this.currentTime = 0; this.readyState = 0 }
  setAttribute() {}
  load() { this.loaded.push(this.src) }
  play() { this.paused = false; this.plays++; return Promise.resolve() }
  pause() { this.paused = true; this.pauses++ }
}

export function mockVisibility() {
  return Object.assign(new EventTarget(), { visibilityState: 'visible' })
}
