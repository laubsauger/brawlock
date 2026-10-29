import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const serverAndScripts = import.meta.glob(['/server/**/*.{mjs,ts}', '/scripts/**/*.{mjs,ts}', '/src/**/*.mjs'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

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

  /** Why: the rate is a process setting (a server's TICK_HZ, the room a client joined), so a tick
   * count converted with a literal 60 or 30, or written as a literal, is right at one rate only.
   * The capacity script measured bot cost per simulated second at twice the truth for days after
   * the 30 Hz switch. Server and script code is plain .mjs the rule above never parses. */
  it('converts ticks and seconds through the rate, never through a literal 60 or 30', () => {
    const tick = String.raw`\b\w*tick(?!et)\w*`
    const rules = [
      // m.ticks / 60, state.tick / 60
      new RegExp(String.raw`${tick}(?:\.\w+)*\)?\s*[*/]\s*(?:30|60)(?![\d._])`, 'i'),
      // tick < seconds * 60, Math.round(seconds * 60) as ticks
      new RegExp(String.raw`${tick}.*\b\w*sec\w*\s*\*\s*(?:30|60)(?![\d._])|\b(?:30|60)\s*\*\s*\w*sec`, 'i'),
      // ticks: 30, phaseTicksLeft = 600 (0 to 3 mean now or the next steps at every rate)
      new RegExp(String.raw`${tick}\s*[:=]\s*(?:[4-9]|\d{2,})(?![\d._])`, 'i'),
    ]
    // a tick count on purpose: [path, the line's code, why]
    const allowed: [string, string, string][] = [
      ['/src/game/replay/viewer.ts', 'const MAX_TICKS_PER_FRAME = 12', 'a cap on work per animation frame, counted in ticks at any rate'],
      ['/src/sim/types.ts', 'export const DEFAULT_TICK_HZ: TickRate = 30', 'the rate itself'],
      ['/src/net/predict.ts', 'static readonly MAX_MARGIN_TICKS = 8', 'the lead margin grows a whole tick per late input; its cap is 133 ms at 60 Hz, 267 ms at 30 Hz'],
    ]
    const code = { ...sources, ...serverAndScripts }
    const misses: string[] = []
    for (const [path, text] of Object.entries(code)) {
      if (/\.test\.\w+$|\/src\/render\/character\/pipeline\//.test(path)) continue
      text.split('\n').forEach((raw, i) => {
        const line = raw.replace(/\/\/.*$/, '').trim()
        if (!line || line.startsWith('*') || line.startsWith('/*')) return
        if (!rules.some((r) => r.test(line)) || allowed.some(([p, snippet]) => p === path && line.includes(snippet))) return
        misses.push(`${path}:${i + 1}: ${line}`)
      })
    }
    expect(misses, 'Use ticks(seconds) / secondsOf(ticks) / TICK_HZ (records: RECORD_HZ, recordSeconds).').toEqual([])
  })
})
