import { captureRendererCanvas } from '../renderBridge'
import { FEEDBACK_IMAGE_BYTES, FEEDBACK_IMAGE_DIMENSION, type FeedbackScreenshot } from '../../net/feedback'

/** Ancestor visibility matters: a warmed match canvas can overlap the visible menu. */
export function visibleForFeedback(element: Element): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  }
  return true
}

/** Capture the real scene now; reconstruct only the UI, before opening the report. */
export async function feedbackScreenshot(): Promise<FeedbackScreenshot> {
  const scenes = new Map<string, { image: string; style: string }>()
  const parents: HTMLElement[] = []
  let sandbox: HTMLIFrameElement | null = null
  let context: import('modern-screenshot').Context | null = null
  try {
    for (const canvas of document.querySelectorAll('canvas')) {
      if (!visibleForFeedback(canvas)) continue
      const parent = canvas.parentElement
      if (!parent || parent.hasAttribute('data-feedback-scene')) throw new Error('Screenshot scene layout is not supported.')
      const frozen = captureRendererCanvas(canvas)
      const id = String(scenes.size)
      const style = getComputedStyle(canvas)
      const properties = ['display', 'width', 'height', 'position', 'top', 'left', 'object-fit', 'border-radius']
      scenes.set(id, { image: frozen.toDataURL('image/png'), style: properties.map((key) => `${key}:${style.getPropertyValue(key)}`).join(';') })
      parent.dataset.feedbackScene = id
      parents.push(parent)
    }
    const { createContext, domToCanvas } = await import('modern-screenshot')
    const scale = Math.min(1, FEEDBACK_IMAGE_DIMENSION / Math.max(innerWidth, innerHeight))
    context = await createContext(document.documentElement, {
      width: innerWidth, height: innerHeight, scale, backgroundColor: '#100d12', timeout: 5000,
      features: { restoreScrollPosition: true },
      // Canvases are inserted from their renderer-owned snapshots, never read after a cleared GPU frame.
      filter: (node) => !(node instanceof HTMLCanvasElement) && !(node instanceof HTMLIFrameElement)
        && (!(node instanceof Element) || (!node.hasAttribute('data-feedback-exclude') && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && Number(getComputedStyle(node).opacity) !== 0)),
      onCloneEachNode: async (node) => {
        if (!(node instanceof HTMLElement)) return
        node.style.animation = 'none'
        node.style.transition = 'none'
        const scene = node.dataset.feedbackScene
        if (scene !== undefined) {
          const source = scenes.get(scene)
          if (!source) throw new Error('Screenshot scene snapshot is missing.')
          const image = document.createElement('img')
          image.src = source.image
          image.style.cssText = source.style
          await image.decode()
          node.prepend(image)
          delete node.dataset.feedbackScene
        }
        // Passwords are excluded even when a browser has filled a hidden field.
        if (node instanceof HTMLInputElement && node.type === 'password') { node.value = ''; node.removeAttribute('value') }
      },
    })
    // modern-screenshot otherwise navigates its style sandbox and reads body in
    // the same task. Own that initialization so srcdoc is ready before cloning.
    sandbox = document.createElement('iframe')
    sandbox.setAttribute('data-feedback-exclude', '')
    sandbox.setAttribute('aria-hidden', 'true')
    sandbox.tabIndex = -1
    sandbox.style.cssText = 'position:fixed;width:0;height:0;visibility:hidden;pointer-events:none'
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Screenshot style frame did not load.')), 5000)
      sandbox!.onload = () => { clearTimeout(timer); resolve() }
      sandbox!.srcdoc = '<!doctype html><html><head><title>Screenshot styles</title></head><body></body></html>'
      document.body.append(sandbox!)
    })
    if (!sandbox.contentDocument?.body) throw new Error('Screenshot style frame is unavailable.')
    context.sandbox = sandbox
    const canvas = await domToCanvas(context)
    // Encode the same image progressively; exceeding the attachment limit is an explicit failure.
    for (const quality of [0.78, 0.6, 0.42]) {
      const url = canvas.toDataURL('image/jpeg', quality)
      const data = url.slice(url.indexOf(',') + 1)
      if (atob(data).length <= FEEDBACK_IMAGE_BYTES) return { mime: 'image/jpeg', data, width: canvas.width, height: canvas.height }
    }
    throw new Error('This screenshot is too large to attach. You can still send the report without it.')
  } finally {
    for (const parent of parents) delete parent.dataset.feedbackScene
    if (context) (await import('modern-screenshot')).destroyContext(context)
    sandbox?.remove()
  }
}
