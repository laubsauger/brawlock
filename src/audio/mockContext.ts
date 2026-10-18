/**
 * Strict fake AudioContext for node tests. It enforces the WebAudio rules that throw
 * or leak at runtime in browsers (exponential ramps to 0, double start, stop before
 * start, non-finite values, sources that never stop) and records every node so tests
 * can assert on the graph. Only the API surface used by src/audio is implemented.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export class MockParam {
  value: number
  readonly calls: { fn: string; v: number; t: number }[] = []
  readonly inputs: MockNode[] = []
  constructor(v: number) {
    this.value = v
  }
  private check(fn: string, v: number, t: number) {
    if (!Number.isFinite(v)) throw new TypeError(`${fn}: non-finite value ${v}`)
    if (!Number.isFinite(t) || t < 0) throw new RangeError(`${fn}: bad time ${t}`)
    this.calls.push({ fn, v, t })
  }
  setValueAtTime(v: number, t: number) {
    this.check('setValueAtTime', v, t)
    this.value = v
    return this
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.check('linearRamp', v, t)
    this.value = v
    return this
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.check('exponentialRamp', v, t)
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime: value must not be 0')
    const prev = this.calls.length > 1 ? this.calls[this.calls.length - 2].v : this.value
    if (prev !== 0 && Math.sign(prev) !== Math.sign(v)) throw new RangeError('exponentialRamp: sign change')
    this.value = v
    return this
  }
  setTargetAtTime(v: number, t: number, tc: number) {
    this.check('setTarget', v, t)
    if (!(tc > 0)) throw new RangeError('setTargetAtTime: time constant must be > 0')
    return this
  }
  cancelScheduledValues(t: number) {
    if (!Number.isFinite(t)) throw new RangeError('cancel: bad time')
    return this
  }
}

export class MockNode {
  readonly outputs: (MockNode | MockParam)[] = []
  disconnected = false
  constructor(
    readonly ctx: MockAudioContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this)
  }
  connect(dest: MockNode | MockParam) {
    if (!(dest instanceof MockNode) && !(dest instanceof MockParam)) throw new TypeError('connect: bad destination')
    this.outputs.push(dest)
    if (dest instanceof MockParam) dest.inputs.push(this)
    return dest
  }
  disconnect() {
    this.disconnected = true
  }
}

class MockSource extends MockNode {
  started: number | null = null
  stopped: number | null = null
  start(t = 0, offset = 0) {
    if (this.started !== null) throw new Error('InvalidStateError: start called twice')
    if (!Number.isFinite(t) || !Number.isFinite(offset) || offset < 0) throw new RangeError('start: bad args')
    this.started = t
  }
  stop(t = 0) {
    if (this.started === null) throw new Error('InvalidStateError: stop before start')
    if (!Number.isFinite(t)) throw new RangeError('stop: bad time')
    this.stopped = t
  }
}

export class MockBuffer {
  readonly duration: number
  private readonly data: Float32Array[]
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
  }
  getChannelData(ch: number) {
    return this.data[ch]
  }
}

export class MockAudioContext {
  static instances: MockAudioContext[] = []
  readonly nodes: MockNode[] = []
  readonly sampleRate = 8000
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  readonly destination = new MockNode(this, 'destination')
  constructor() {
    MockAudioContext.instances.push(this)
  }
  /** like browsers: the state flips when the promise settles, not synchronously */
  resume() {
    return Promise.resolve().then(() => {
      this.state = 'running'
    })
  }
  createGain() {
    return Object.assign(new MockNode(this, 'gain'), { gain: new MockParam(1) })
  }
  createOscillator() {
    return Object.assign(new MockSource(this, 'osc'), {
      type: 'sine',
      frequency: new MockParam(440),
      detune: new MockParam(0),
    })
  }
  createBiquadFilter() {
    return Object.assign(new MockNode(this, 'biquad'), {
      type: 'lowpass',
      frequency: new MockParam(350),
      Q: new MockParam(1),
      gain: new MockParam(0),
    })
  }
  createBufferSource() {
    return Object.assign(new MockSource(this, 'buffer'), {
      buffer: null as MockBuffer | null,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: new MockParam(1),
    })
  }
  createMediaElementSource(_media: HTMLMediaElement) {
    return new MockNode(this, 'media')
  }
  createWaveShaper() {
    return Object.assign(new MockNode(this, 'shaper'), { curve: null, oversample: 'none' })
  }
  createStereoPanner() {
    return Object.assign(new MockNode(this, 'panner'), { pan: new MockParam(0) })
  }
  createDynamicsCompressor() {
    return Object.assign(new MockNode(this, 'compressor'), {
      threshold: new MockParam(-24),
      knee: new MockParam(30),
      ratio: new MockParam(12),
      attack: new MockParam(0.003),
      release: new MockParam(0.25),
    })
  }
  createConvolver() {
    return Object.assign(new MockNode(this, 'convolver'), { buffer: null })
  }
  /** decodes any bytes into a 0.5 s buffer (enough for layering tests) */
  decodeAudioData(_data: ArrayBuffer) {
    return Promise.resolve(new MockBuffer(1, Math.floor(this.sampleRate * 0.5), this.sampleRate))
  }
  createBuffer(channels: number, length: number, rate: number) {
    if (!(length > 0)) throw new RangeError('createBuffer: length must be > 0')
    return new MockBuffer(channels, length, rate)
  }

  /** Sources that were started but never told to stop (they would run forever). */
  leakingSources(): MockNode[] {
    return this.nodes.filter((n) => n instanceof MockSource && n.started !== null && n.stopped === null)
  }

  sources(): MockSource[] {
    return this.nodes.filter((n): n is MockSource => n instanceof MockSource)
  }
}

export function asContext(m: MockAudioContext): BaseAudioContext {
  return m as any as BaseAudioContext
}
