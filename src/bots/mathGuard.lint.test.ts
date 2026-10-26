import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const sources = import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const exact = new Set(['abs', 'ceil', 'floor', 'round', 'trunc', 'min', 'max', 'sqrt', 'sign', 'imul', 'clz32', 'fround',
  'E', 'LN10', 'LN2', 'LOG10E', 'LOG2E', 'PI', 'SQRT1_2', 'SQRT2'])

describe('bot cross-engine math contract', () => {
  it('uses deterministic sim math for every engine-dependent operation, including aliased calls', () => {
    const violations: string[] = []
    for (const [path, text] of Object.entries(sources)) {
      if (path.endsWith('.test.ts')) continue
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === 'Math') {
          const parent = node.parent
          if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node || !exact.has(parent.name.text)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
            violations.push(`${path}:${line + 1}: ${parent.getText(source)}`)
          }
        }
        // Squaring is a basic multiplication; general exponentiation is engine libm too.
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken
          && !(ts.isNumericLiteral(node.right) && node.right.text === '2')) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          violations.push(`${path}:${line + 1}: ${node.getText(source)}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations, 'Route transcendental functions, hypot and random through deterministic sim math / the seeded RNG.').toEqual([])
  })
})
