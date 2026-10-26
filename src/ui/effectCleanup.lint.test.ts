import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * Whatever an effect returns, React keeps as its cleanup and calls on the next
 * run or on unmount. Anything but a function or undefined crashes the whole
 * app there ("M is not a function"; the React root unmounts, the screen goes
 * blank). TypeScript does not catch it: a `() => void` call is assignable to
 * an effect, and `void` hides what it returns at runtime.
 *
 * The live crash: `useEffect(() => el?.scrollIntoView(), [openId])` in Your
 * record. lib.dom types scrollIntoView as void, but Chrome 153+ returns a
 * Promise from the scroll methods, so closing an opened match crashed.
 *
 * This scans every effect (and every useSyncExternalStore subscribe, whose
 * return React also keeps as a cleanup) with the type checker. Allowed returns:
 * nothing, undefined, a function literal, or an expression whose type is only
 * functions (and undefined). A void-typed call is not allowed: wrap it in a
 * block body, `() => { el.focus() }`.
 */

// repo root with a trailing slash (no node typings in the app tsconfig: plain URL / string paths)
const root = decodeURIComponent(new URL('../../', import.meta.url).pathname)
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect'])

function scan(): { count: number; bad: string[] } {
  const cfg = ts.readConfigFile(root + 'tsconfig.json', ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root)
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  const checker = program.getTypeChecker()
  const bad: string[] = []
  let count = 0

  // every part is a function, undefined or never (a void / any / unknown / object part is not)
  const onlyFunctions = (t: ts.Type): boolean =>
    (t.isUnion() ? t.types : [t]).every((p) => p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Never) || (!(p.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void)) && p.getCallSignatures().length > 0))

  const returnedExpressions = (fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] => {
    if (!ts.isBlock(fn.body)) return [fn.body]
    const out: ts.Expression[] = []
    const walk = (n: ts.Node): void => {
      if (ts.isFunctionLike(n)) return // a nested function's returns are its own
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression)
      ts.forEachChild(n, walk)
    }
    ts.forEachChild(fn.body, walk)
    return out
  }

  const fine = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true
    if (ts.isIdentifier(e) && e.text === 'undefined') return true
    return onlyFunctions(checker.getTypeAtLocation(e))
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(root + 'src/') || /\.test\.tsx?$/.test(sf.fileName)) continue
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.arguments.length > 0) {
        const callee = n.expression
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
        const where = () => `${sf.fileName.slice(root.length)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
        const arg = n.arguments[0]
        if (EFFECT_HOOKS.has(name) || name === 'useSyncExternalStore') {
          count++
          let ok: boolean
          if (EFFECT_HOOKS.has(name) && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) ok = returnedExpressions(arg).every(fine)
          else {
            // a function passed by reference (or a subscribe): judge its declared return type
            const sig = checker.getTypeAtLocation(arg).getCallSignatures()[0]
            ok = !!sig && onlyFunctions(checker.getReturnTypeOfSignature(sig))
          }
          if (!ok) bad.push(`${where()} ${name}: ${arg.getText().replace(/\s+/g, ' ').slice(0, 90)}`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return { count, bad }
}

describe('effect cleanups', () => {
  it('no effect returns anything React would call as a cleanup but cannot (blank-screen crash)', () => {
    const { count, bad } = scan()
    expect(count).toBeGreaterThan(50) // the scan really found the effects
    expect(bad).toEqual([])
  }, 60_000)
})
