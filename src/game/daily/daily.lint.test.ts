import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * The daily verifier replays a tape on the account service and in every player's browser
 * (docs/moonshot/specs/daily.md): its modules must give the same answer everywhere. They import
 * only the sim, the bots, the command codec and the pure moments engine, and never read the clock,
 * a random source or engine-dependent math.
 */
const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const PURE = ['./calendar.ts', './run.ts', './tape.ts', './verify.ts']
const ALLOWED = [/^\.\.\/\.\.\/sim(\/|$)/, /^\.\.\/\.\.\/bots\//, /^\.\.\/\.\.\/net\/stream$/, /^\.\.\/moments$/, /^\.\.\/progressionCatalog$/, /^\.\/(calendar|run|tape|verify)$/]
const EXACT_MATH = new Set(['abs', 'ceil', 'floor', 'round', 'trunc', 'min', 'max', 'sqrt', 'sign', 'imul'])

describe('daily verifier purity', () => {
  it('imports only pure modules, and never Date, performance, Math.random or engine-dependent math', () => {
    const violations: string[] = []
    for (const path of PURE) {
      const text = sources[path]
      expect(text, path).toBeDefined()
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      const at = (node: ts.Node) => `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !ALLOWED.some((r) => r.test((node.moduleSpecifier as ts.StringLiteral).text))) {
          violations.push(`${at(node)}: imports ${node.moduleSpecifier.text}`)
        }
        if (ts.isIdentifier(node) && (node.text === 'Date' || node.text === 'performance')) violations.push(`${at(node)}: ${node.text}`)
        if (ts.isIdentifier(node) && node.text === 'Math' && ts.isPropertyAccessExpression(node.parent) && !EXACT_MATH.has(node.parent.name.text)) {
          violations.push(`${at(node)}: Math.${node.parent.name.text}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })
})
