import { afterEach, describe, expect, it } from 'vitest'
import ts from 'typescript'
import { CAST_TURN_LIMIT_TICKS, ORIGINAL_TICK_SCALE, TURN_PER_TICK, ticks } from './config'
import { cmd, newMatch, pawn, run } from './testkit'
import { DT, TICK_HZ, TICK_RATES, setTickRate } from './types'

const startRate = TICK_HZ
afterEach(() => setTickRate(startRate))

describe('simulation rate per process (30 or 60 Hz)', () => {
  /** Why: a game server runs either rate from its config and a client switches to the rate of
   * the room it joins, so constants derived from the rate must follow every switch. */
  it('recomputes rate-derived constants when the rate changes', () => {
    for (const hz of TICK_RATES) {
      setTickRate(hz)
      expect(TICK_HZ).toBe(hz)
      expect(DT).toBe(1 / hz)
      expect(ticks(1)).toBe(hz)
      // 1.2 rad per 0.03 s: 40 rad/s at any rate
      expect(TURN_PER_TICK * hz).toBeCloseTo(40, 9)
      expect(CAST_TURN_LIMIT_TICKS).toBe(Math.ceil(Math.PI / TURN_PER_TICK) + 1)
      expect(ORIGINAL_TICK_SCALE).toBeCloseTo(1 / hz / 0.035, 12)
    }
    expect(() => setTickRate(45)).toThrow(/Unsupported tick rate/)
  })

  /** Why: the rate is a server cost and latency choice, not a game rule. The same orders must
   * play out in the same seconds and the same distances at either rate. */
  it('plays the same match in the same seconds and distances at either rate', () => {
    const seen = TICK_RATES.map((hz) => {
      setTickRate(hz)
      const s = newMatch({ shopSeconds: 4 })
      const shopTicks = s.phaseTicksLeft
      const x0 = pawn(s, 0).x
      run(s, ticks(2), () => [cmd(0, { kind: 'move', x: x0 - 2000, y: 0 })])
      return { hz, shopSeconds: shopTicks / hz, walked: x0 - pawn(s, 0).x }
    })
    expect(seen[0].shopSeconds).toBe(4)
    expect(seen[1].shopSeconds).toBe(4)
    // whole ticks of turning before walking differ by at most one tick of walk speed
    expect(Math.abs(seen[0].walked - seen[1].walked)).toBeLessThan(210 / 30 + 1)
    expect(seen[0].walked).toBeGreaterThan(300)
  })
})

const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('rate-derived module constants', () => {
  /** Why: a module-level constant computed from TICK_HZ, DT or ticks() at import keeps the
   * first rate forever; after a switch it would silently mean other seconds. Such constants
   * are assigned in onTickRate instead. */
  it('computes every module-level value derived from the tick rate inside onTickRate', () => {
    const rate = new Set(['TICK_HZ', 'DT', 'ticks', 'secondsOf', 'frictionPerTick'])
    const files = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path)).map(([path, text]) => {
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      // names assigned in onTickRate are rate-derived too: a constant built from them is stale as well
      const assigned = new Set<string>()
      const visit = (node: ts.Node, inRate: boolean) => {
        if (inRate && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) assigned.add(node.left.text)
        const rateCall = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'onTickRate'
        ts.forEachChild(node, (child) => visit(child, inRate || rateCall))
      }
      visit(source, false)
      for (const name of assigned) rate.add(name)
      // module constants, and static class fields (initialized once, when the class is defined)
      const decls = source.statements.flatMap<ts.VariableDeclaration | ts.PropertyDeclaration>((st) => ts.isVariableStatement(st) ? [...st.declarationList.declarations]
        : ts.isClassDeclaration(st) ? st.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m)
          && !!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)) : [])
      // a file's own fixed binding of a rate name (e.g. a dev tool's DT = 1 / 60) is not the sim's
      const own = new Set(decls.flatMap((d) => ts.isIdentifier(d.name) && !assigned.has(d.name.text) ? [d.name.text] : []))
      return { path, source, decls, own }
    })
    const violations: string[] = []
    let grew = true
    while (grew) {
      grew = false
      for (const { path, source, decls, own } of files) {
        for (const d of decls) {
          if (!d.initializer || !ts.isIdentifier(d.name) || rate.has(d.name.text) || ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) continue
          const uses = new Set<string>()
          const walk = (n: ts.Node) => {
            if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isAccessor(n)) return
            if (ts.isIdentifier(n) && rate.has(n.text) && !own.has(n.text)) uses.add(n.text)
            ts.forEachChild(n, walk)
          }
          walk(d.initializer)
          if (uses.size === 0) continue
          const { line } = source.getLineAndCharacterOfPosition(d.getStart(source))
          violations.push(`${path}:${line + 1}: ${d.name.text} <- ${[...uses].join(', ')}`)
          rate.add(d.name.text)
          grew = true
        }
      }
    }
    expect(violations, 'Assign module-level values derived from the tick rate in onTickRate(() => { ... }).').toEqual([])
  })
})
