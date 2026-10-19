/**
 * Deterministic math for the sim.
 *
 * Engine Math.sin/cos/atan2/exp/log/pow are not specified bit-exactly by ECMAScript and differ
 * between engines (and V8 versions). Everything here uses only IEEE-754 basic operations
 * (+ - * /), Math.sqrt (correctly rounded by spec), Math.floor and Math.abs, which are exact
 * on every engine. Algorithms and coefficients follow fdlibm (Sun, freely redistributable),
 * re-typed from the published algorithm description; accuracy is within ~1 ulp of libm for the
 * argument ranges the game uses (|x| < 1e5).
 */

export const PI = 3.141592653589793
export const TAU = 6.283185307179586
export const HALF_PI = 1.5707963267948966

// ---------------------------------------------------------------------------
// sin / cos
// ---------------------------------------------------------------------------

const INV_PIO2 = 6.36619772367581382433e-1
const PIO2_1 = 1.57079632673412561417 // first 33 bits of pi/2
const PIO2_1T = 6.07710050650619224932e-11 // pi/2 - PIO2_1

const S1 = -1.66666666666666324348e-1
const S2 = 8.33333333332248946124e-3
const S3 = -1.98412698298579493134e-4
const S4 = 2.75573137070700676789e-6
const S5 = -2.50507602534068634195e-8
const S6 = 1.58969099521155010221e-10

const C1 = 4.16666666666666019037e-2
const C2 = -1.38888888888741095749e-3
const C3 = 2.48015872894767294178e-5
const C4 = -2.75573143513906633035e-7
const C5 = 2.08757232129817482790e-9
const C6 = -1.13596475577881948265e-11

/** sin on [-pi/4, pi/4]; y is the tail of the reduced argument. */
function kSin(x: number, y: number): number {
  const z = x * x
  const v = z * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  return x - (z * (0.5 * y - v * r) - y - v * S1)
}

/** cos on [-pi/4, pi/4]; y is the tail of the reduced argument. */
function kCos(x: number, y: number): number {
  const z = x * x
  const w = z * z
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6))
  const hz = 0.5 * z
  const ww = 1 - hz
  return ww + (1 - ww - hz + (z * r - x * y))
}

// Reduction result buffer (module scratch, never part of state).
let redHi = 0
let redLo = 0

/** x = n * pi/2 + (redHi + redLo); returns n. Cody-Waite with a 33-bit pi/2 head. */
function remPio2(x: number): number {
  const n = Math.floor(x * INV_PIO2 + 0.5)
  const r = x - n * PIO2_1 // exact for |n| < 2^20
  const w = n * PIO2_1T
  redHi = r - w
  redLo = r - redHi - w
  return n
}

export function sin(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN
  if (Math.abs(x) <= 0.7853981633974483) return kSin(x, 0)
  const n = remPio2(x)
  switch (((n % 4) + 4) % 4) {
    case 0:
      return kSin(redHi, redLo)
    case 1:
      return kCos(redHi, redLo)
    case 2:
      return -kSin(redHi, redLo)
    default:
      return -kCos(redHi, redLo)
  }
}

export function cos(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN
  if (Math.abs(x) <= 0.7853981633974483) return kCos(x, 0)
  const n = remPio2(x)
  switch (((n % 4) + 4) % 4) {
    case 0:
      return kCos(redHi, redLo)
    case 1:
      return -kSin(redHi, redLo)
    case 2:
      return -kCos(redHi, redLo)
    default:
      return kSin(redHi, redLo)
  }
}

// ---------------------------------------------------------------------------
// atan / atan2
// ---------------------------------------------------------------------------

const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.5707963267948965580]
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]
const AT0 = 3.33333333333329318027e-1
const AT1 = -1.99999999998764832476e-1
const AT2 = 1.42857142725034663711e-1
const AT3 = -1.11111104054623557880e-1
const AT4 = 9.09088713343650656196e-2
const AT5 = -7.69187620504482999495e-2
const AT6 = 6.66107313738753120669e-2
const AT7 = -5.83357013379057348645e-2
const AT8 = 4.97687799461593236017e-2
const AT9 = -3.65315727442169155270e-2
const AT10 = 1.62858201153657823623e-2

export function atan(x: number): number {
  if (x !== x) return NaN
  const neg = x < 0
  let ax = neg ? -x : x
  if (ax >= 7.378697629483821e19) {
    const z = ATAN_HI[3] + ATAN_LO[3]
    return neg ? -z : z
  }
  let id: number
  if (ax < 0.4375) {
    if (ax < 7.450580596923828e-9) return x
    id = -1
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0
      ax = (2 * ax - 1) / (2 + ax)
    } else {
      id = 1
      ax = (ax - 1) / (ax + 1)
    }
  } else if (ax < 2.4375) {
    id = 2
    ax = (ax - 1.5) / (1 + 1.5 * ax)
  } else {
    id = 3
    ax = -1 / ax
  }
  const xx = id < 0 ? x : ax
  const z = xx * xx
  const w = z * z
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))))
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))))
  if (id < 0) return xx - xx * (s1 + s2)
  const r = ATAN_HI[id] - (xx * (s1 + s2) - ATAN_LO[id] - xx)
  return neg ? -r : r
}

const PI_LO = 1.2246467991473531772e-16

/** Angle of (x, y) in (-pi, pi]. atan2(0, 0) = 0. */
export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN
  if (y === 0) return x < 0 ? PI : 0
  if (x === 0) return y > 0 ? HALF_PI : -HALF_PI
  const z = atan(Math.abs(y / x))
  if (x > 0) return y < 0 ? -z : z
  return y < 0 ? z - PI_LO - PI : PI - (z - PI_LO)
}

/** Inverse sine on [-1, 1], preserving precision near both endpoints. */
export function asin(x: number): number {
  if (x !== x || Math.abs(x) > 1) return NaN
  if (x === 0) return x
  return atan2(x, Math.sqrt((1 - x) * (1 + x)))
}

// ---------------------------------------------------------------------------
// exp / log / pow (setup-time only, e.g. friction conversion)
// ---------------------------------------------------------------------------

const LN2_HI = 6.93147180369123816490e-1
const LN2_LO = 1.90821492927058770002e-10
const INV_LN2 = 1.44269504088896338700
const P1 = 1.66666666666666019037e-1
const P2 = -2.77777777770155933842e-3
const P3 = 6.61375632143793436117e-5
const P4 = -1.65339022054652515390e-6
const P5 = 4.13813679705723846039e-8

/** 2^k by repeated exact scaling (no Math.pow). */
function pow2(k: number): number {
  let r = 1
  if (k > 0) for (let i = 0; i < k; i++) r *= 2
  else for (let i = 0; i < -k; i++) r *= 0.5
  return r
}

export function exp(x: number): number {
  if (x !== x) return NaN
  if (x > 709.78) return Infinity
  if (x < -745.13) return 0
  const k = Math.floor(x * INV_LN2 + 0.5)
  const hi = x - k * LN2_HI
  const lo = k * LN2_LO
  const r = hi - lo
  const t = r * r
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  const y = 1 - (lo - (r * c) / (2 - c) - hi)
  // split the scale so 2^k never overflows on its own near the limits
  if (k > 1000) return y * pow2(k - 1000) * pow2(1000)
  if (k < -1000) return y * pow2(k + 1000) * pow2(-1000)
  return y * pow2(k)
}

const LG1 = 6.666666666666735130e-1
const LG2 = 3.999999999940941908e-1
const LG3 = 2.857142874366239149e-1
const LG4 = 2.222219843214978396e-1
const LG5 = 1.818357216161805012e-1
const LG6 = 1.531383769920937332e-1
const LG7 = 1.479819860511658591e-1
const SQRT2 = 1.4142135623730951
const SQRT1_2 = 0.7071067811865476

export function log(x: number): number {
  if (x !== x || x < 0) return NaN
  if (x === 0) return -Infinity
  if (x === Infinity) return Infinity
  // x = 2^k * m with m in [sqrt(1/2), sqrt(2)); scaling by 2 is exact
  let k = 0
  let m = x
  while (m >= SQRT2) {
    m *= 0.5
    k++
  }
  while (m < SQRT1_2) {
    m *= 2
    k--
  }
  const f = m - 1
  const s = f / (2 + f)
  const z = s * s
  const w = z * z
  const t1 = w * (LG2 + w * (LG4 + w * LG6))
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
  const R = t2 + t1
  const hfsq = 0.5 * f * f
  return k * LN2_HI - (hfsq - (s * (hfsq + R) + k * LN2_LO) - f)
}

/** x^y for x > 0 via exp(y * log(x)). Deterministic, ~1e-15 relative error. */
export function pow(x: number, y: number): number {
  if (y === 0) return 1
  if (x === 0) return y > 0 ? 0 : Infinity
  return exp(y * log(x))
}

// ---------------------------------------------------------------------------
// Vectors and angles
// ---------------------------------------------------------------------------

export function length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y)
}

/** Two-dimensional length, scaled to avoid overflow or underflow when squaring. */
export function hypot(x: number, y: number): number {
  const a = Math.abs(x)
  const b = Math.abs(y)
  if (a === Infinity || b === Infinity) return Infinity
  if (a !== a || b !== b) return NaN
  const hi = Math.max(a, b)
  if (hi === 0) return 0
  const ratio = Math.min(a, b) / hi
  return hi * Math.sqrt(1 + ratio * ratio)
}

/** Wrap an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  if (a > PI || a <= -PI) {
    a = a - TAU * Math.floor((a + PI) / TAU)
    if (a <= -PI) a += TAU
    if (a > PI) a -= TAU
  }
  return a
}

/** Signed shortest rotation from `from` to `to`, in (-pi, pi]. */
export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from)
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
