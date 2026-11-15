/**
 * A recording canvas for jsdom (which has none): `installFakeCanvas()` makes `HTMLCanvasElement.getContext` and a
 * global `OffscreenCanvas` return fakes that accept every call and fold it into a running hash, so two runs can be
 * compared ("did these frames draw the same?") without storing the calls. The 2D fake tracks the transform and the
 * extent of what is filled or stroked on a canvas marked as the stage, for the "stays inside the canvas" check.
 * The WebGL2 fake answers enough for a character to compile, link and draw (every shader compiles); its calls are
 * hashed too.
 */

/** What one frame (or one run) drew. */
export class Recording {
  calls = 0
  /** When set, every 2D call and property set is also appended here (for tests that look at what was drawn). */
  log: Array<{ readonly name: string; readonly args: ReadonlyArray<unknown> }> | null = null
  hash = 0x811c9dc5
  /** Extent of filled and stroked geometry on the stage canvas, device pixels. */
  minX = Infinity
  minY = Infinity
  maxX = -Infinity
  maxY = -Infinity

  reset(): void {
    this.calls = 0
    this.hash = 0x811c9dc5
    this.minX = this.minY = Infinity
    this.maxX = this.maxY = -Infinity
  }

  mix(n: number): void {
    let h = this.hash ^ (n | 0)
    h = Math.imul(h, 0x01000193)
    this.hash = h >>> 0
  }

  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i))
    this.mix(s.length)
  }

  value(v: unknown): void {
    if (typeof v === "number") this.mix(Number.isFinite(v) ? Math.round(v * 10) : 0x7fffffff)
    else if (typeof v === "string") this.str(v)
    else if (typeof v === "boolean") this.mix(v ? 1 : 2)
    else if (v === null || v === undefined) this.mix(3)
    else if (ArrayBuffer.isView(v)) {
      const a = v as unknown as ArrayLike<number>
      const n = Math.min(a.length, 64)
      for (let i = 0; i < n; i++) this.value(a[i])
      this.mix(a.length)
    } else if (Array.isArray(v)) {
      for (const x of v) this.value(x)
      this.mix(v.length)
    } else this.mix(4)
  }

  get digest(): string {
    return (this.hash >>> 0).toString(16).padStart(8, "0")
  }
}

/** The recording every fake writes into. */
export const recording = new Recording()

/** Canvases whose drawing extent is tracked (the character's own canvas). */
const stages = new WeakSet<object>()
export const markStage = (canvas: object): void => {
  stages.add(canvas)
}

type Matrix = [number, number, number, number, number, number]

const DEFAULTS: { readonly [k: string]: unknown } = {
  lineWidth: 1,
  globalAlpha: 1,
  font: "10px sans-serif",
  fillStyle: "#000000",
  strokeStyle: "#000000",
  shadowBlur: 0,
  shadowColor: "rgba(0, 0, 0, 0)",
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  lineCap: "butt",
  lineJoin: "miter",
  miterLimit: 10,
  lineDashOffset: 0,
  globalCompositeOperation: "source-over",
  textAlign: "start",
  textBaseline: "alphabetic",
  direction: "inherit",
  filter: "none",
  imageSmoothingEnabled: true,
  imageSmoothingQuality: "low",
  letterSpacing: "0px",
  fontKerning: "auto",
  wordSpacing: "0px"
}

const ids = new Map<string, number>()
const idOf = (name: string): number => {
  let id = ids.get(name)
  if (id === undefined) {
    id = 0
    for (let i = 0; i < name.length; i++) id = (Math.imul(id, 31) + name.charCodeAt(i)) | 0
    ids.set(name, id)
  }
  return id
}

const imageData = (w: number, h: number) => {
  const width = Math.max(1, Math.floor(Math.abs(w)) || 1)
  const height = Math.max(1, Math.floor(Math.abs(h)) || 1)
  return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }
}

const gradient = (rec: Recording) => ({
  addColorStop: (offset: number, color: string) => {
    rec.mix(idOf("addColorStop"))
    rec.value(offset)
    rec.value(color)
  }
})

interface CanvasLike {
  width: number
  height: number
}

/** A recording 2D context for `canvas`. */
export const fake2d = (canvas: CanvasLike, rec: Recording = recording): CanvasRenderingContext2D => {
  const props = new Map<string, unknown>()
  let m: Matrix = [1, 0, 0, 1, 0, 0]
  // The clip's extent (device px); drawing is counted only inside it.
  let clip: [number, number, number, number] = [-Infinity, -Infinity, Infinity, Infinity]
  const stack: Array<{ m: Matrix; props: Map<string, unknown>; clip: [number, number, number, number] }> = []
  let dash: Array<number> = []
  // Extent of the current path (device px), committed on fill or stroke.
  let pMinX = Infinity
  let pMinY = Infinity
  let pMaxX = -Infinity
  let pMaxY = -Infinity
  const track = stages.has(canvas)
  const point = (x: number, y: number) => {
    if (!track || !Number.isFinite(x) || !Number.isFinite(y)) return
    const dx = m[0] * x + m[2] * y + m[4]
    const dy = m[1] * x + m[3] * y + m[5]
    if (dx < pMinX) pMinX = dx
    if (dx > pMaxX) pMaxX = dx
    if (dy < pMinY) pMinY = dy
    if (dy > pMaxY) pMaxY = dy
  }
  const box = (x: number, y: number, w: number, h: number) => {
    point(x, y)
    point(x + w, y)
    point(x, y + h)
    point(x + w, y + h)
  }
  const resetPath = () => {
    pMinX = pMinY = Infinity
    pMaxX = pMaxY = -Infinity
  }
  const commit = () => {
    if (!track || pMinX === Infinity) return
    const x0 = Math.max(pMinX, clip[0])
    const y0 = Math.max(pMinY, clip[1])
    const x1 = Math.min(pMaxX, clip[2])
    const y1 = Math.min(pMaxY, clip[3])
    if (x0 > x1 || y0 > y1) return
    if (x0 < rec.minX) rec.minX = x0
    if (x1 > rec.maxX) rec.maxX = x1
    if (y0 < rec.minY) rec.minY = y0
    if (y1 > rec.maxY) rec.maxY = y1
  }
  /** Points along an elliptical arc (local coordinates), so a short arc of a big circle counts as short. */
  const arcPoints = (x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw: boolean) => {
    let span = ccw ? a0 - a1 : a1 - a0
    if (!Number.isFinite(span)) return
    if (span < 0 || Math.abs(span) >= 2 * Math.PI) span = Math.abs(span) >= 2 * Math.PI ? 2 * Math.PI : span + 2 * Math.PI * Math.ceil(-span / (2 * Math.PI))
    const n = Math.max(2, Math.ceil(span / (Math.PI / 8)))
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    for (let i = 0; i <= n; i++) {
      const a = a0 + (ccw ? -1 : 1) * (span * i) / n
      const ex = rx * Math.cos(a)
      const ey = ry * Math.sin(a)
      point(x + ex * cr - ey * sr, y + ex * sr + ey * cr)
    }
  }
  const mul = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]]
  }
  const special: { [k: string]: (...a: Array<never>) => unknown } = {
    save: () => {
      stack.push({ m: [...m], props: new Map(props), clip: [...clip] })
    },
    restore: () => {
      const s = stack.pop()
      if (s === undefined) return
      m = s.m
      clip = s.clip
      props.clear()
      for (const [k, v] of s.props) props.set(k, v)
    },
    reset: () => {
      m = [1, 0, 0, 1, 0, 0]
      clip = [-Infinity, -Infinity, Infinity, Infinity]
      props.clear()
      stack.length = 0
      resetPath()
    },
    setTransform: ((a: number | { a: number; b: number; c: number; d: number; e: number; f: number } = 1, b = 0, c = 0, d = 1, e = 0, f = 0) => {
      m = typeof a === "object" ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b, c, d, e, f]
    }) as never,
    resetTransform: () => {
      m = [1, 0, 0, 1, 0, 0]
    },
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5], is2D: true, isIdentity: false }),
    transform: ((a: number, b: number, c: number, d: number, e: number, f: number) => mul(a, b, c, d, e, f)) as never,
    translate: ((x: number, y: number) => mul(1, 0, 0, 1, x, y)) as never,
    scale: ((x: number, y: number) => mul(x, 0, 0, y, 0, 0)) as never,
    rotate: ((r: number) => mul(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0)) as never,
    beginPath: () => resetPath(),
    moveTo: ((x: number, y: number) => point(x, y)) as never,
    lineTo: ((x: number, y: number) => point(x, y)) as never,
    quadraticCurveTo: ((_cx: number, _cy: number, x: number, y: number) => point(x, y)) as never,
    bezierCurveTo: ((_a: number, _b: number, _c: number, _d: number, x: number, y: number) => point(x, y)) as never,
    arcTo: ((x1: number, y1: number, x2: number, y2: number) => {
      point(x1, y1)
      point(x2, y2)
    }) as never,
    arc: ((x: number, y: number, r: number, a0: number, a1: number, ccw = false) => arcPoints(x, y, Math.abs(r), Math.abs(r), 0, a0, a1, ccw)) as never,
    ellipse: ((x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false) => arcPoints(x, y, Math.abs(rx), Math.abs(ry), rot, a0, a1, ccw)) as never,
    clip: () => {
      if (pMinX === Infinity) return
      clip = [Math.max(clip[0], pMinX), Math.max(clip[1], pMinY), Math.min(clip[2], pMaxX), Math.min(clip[3], pMaxY)]
    },
    rect: ((x: number, y: number, w: number, h: number) => box(x, y, w, h)) as never,
    roundRect: ((x: number, y: number, w: number, h: number) => box(x, y, w, h)) as never,
    // Only solid paint counts towards the extent: a gradient or pattern is a glow or a halo, meant to fade out at
    // the canvas edge, and its geometry (often a big circle) says nothing about where it is visible.
    fill: () => {
      if (typeof (props.get("fillStyle") ?? DEFAULTS.fillStyle) === "string") commit()
    },
    stroke: () => {
      if (typeof (props.get("strokeStyle") ?? DEFAULTS.strokeStyle) === "string") commit()
    },
    fillRect: ((x: number, y: number, w: number, h: number) => {
      resetPath()
      box(x, y, w, h)
      if (typeof (props.get("fillStyle") ?? DEFAULTS.fillStyle) === "string") commit()
      resetPath()
    }) as never,
    strokeRect: ((x: number, y: number, w: number, h: number) => {
      resetPath()
      box(x, y, w, h)
      commit()
      resetPath()
    }) as never,
    fillText: ((_t: string, x: number, y: number) => {
      resetPath()
      point(x, y)
      commit()
      resetPath()
    }) as never,
    strokeText: ((_t: string, x: number, y: number) => {
      resetPath()
      point(x, y)
      commit()
      resetPath()
    }) as never,
    setLineDash: ((d: Array<number>) => {
      dash = [...d]
    }) as never,
    getLineDash: () => [...dash],
    createLinearGradient: () => gradient(rec),
    createRadialGradient: () => gradient(rec),
    createConicGradient: () => gradient(rec),
    createPattern: () => ({ setTransform: () => undefined }),
    createImageData: ((w: number | { width: number; height: number }, h?: number) => (typeof w === "object" ? imageData(w.width, w.height) : imageData(w, h ?? 1))) as never,
    getImageData: ((_x: number, _y: number, w: number, h: number) => imageData(w, h)) as never,
    measureText: ((t: string) => ({ width: String(t).length * 6, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: String(t).length * 6, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 })) as never,
    isPointInPath: () => false,
    isPointInStroke: () => false,
    getContextAttributes: () => ({ alpha: true, desynchronized: false, colorSpace: "srgb", willReadFrequently: false }),
    isContextLost: () => false
  }
  const fns = new Map<string, (...a: Array<unknown>) => unknown>()
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined
      if (prop === "canvas") return canvas
      if (prop === "__reset") return special.reset
      if (props.has(prop)) return props.get(prop)
      if (Object.hasOwn(DEFAULTS, prop)) return DEFAULTS[prop]
      let fn = fns.get(prop)
      if (fn === undefined) {
        const id = idOf(prop)
        const own = special[prop] as ((...a: Array<unknown>) => unknown) | undefined
        fn = (...args: Array<unknown>) => {
          rec.calls++
          rec.mix(id)
          for (const a of args) rec.value(a)
          rec.log?.push({ name: prop, args })
          return own?.(...args)
        }
        fns.set(prop, fn)
      }
      return fn
    },
    set(_t, prop, value) {
      if (typeof prop === "symbol") return true
      props.set(prop, value)
      rec.mix(idOf(prop))
      rec.value(value)
      rec.log?.push({ name: `=${prop}`, args: [value] })
      return true
    }
  })
  return ctx as unknown as CanvasRenderingContext2D
}

/** A WebGL2 context that accepts everything: shaders compile, programs link, draws are hashed. */
export const fakeWebgl2 = (canvas: CanvasLike, rec: Recording = recording): WebGL2RenderingContext => {
  const fns = new Map<string, (...a: Array<unknown>) => unknown>()
  const answer = (prop: string, args: Array<unknown>): unknown => {
    if (prop.startsWith("create")) return { kind: prop }
    switch (prop) {
      case "getShaderParameter":
      case "getProgramParameter":
        return true
      case "getError":
        return 0
      case "isContextLost":
        return false
      case "getShaderInfoLog":
      case "getProgramInfoLog":
        return ""
      case "getUniformLocation":
        return { uniform: args[1] }
      case "getAttribLocation":
        return 0
      case "getUniformBlockIndex":
        return 0
      case "getExtension":
        return new Proxy({}, { get: () => () => undefined })
      case "getSupportedExtensions":
        return []
      case "getParameter":
        return 4096
      case "getContextAttributes":
        return { alpha: true, antialias: false, premultipliedAlpha: true }
      case "checkFramebufferStatus":
        return 0x8cd5 // FRAMEBUFFER_COMPLETE
      default:
        return undefined
    }
  }
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined
      if (prop === "canvas") return canvas
      if (prop === "drawingBufferWidth") return canvas.width
      if (prop === "drawingBufferHeight") return canvas.height
      if (prop === "NO_ERROR") return 0
      if (prop === "FRAMEBUFFER_COMPLETE") return 0x8cd5
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return (idOf(prop) & 0xffff) + 1
      let fn = fns.get(prop)
      if (fn === undefined) {
        const id = idOf(prop)
        fn = (...args: Array<unknown>) => {
          rec.calls++
          rec.mix(id)
          for (const a of args) rec.value(a)
          return answer(prop, args)
        }
        fns.set(prop, fn)
      }
      return fn
    },
    set() {
      return true
    }
  })
  return ctx as unknown as WebGL2RenderingContext
}

type Ctx = { readonly type: string; readonly ctx: unknown }
const contexts = new WeakMap<object, Ctx>()

const getContext = function (this: CanvasLike, type: string): unknown {
  const had = contexts.get(this)
  if (had !== undefined) return had.type === type ? had.ctx : null
  const ctx = type === "2d" ? fake2d(this) : type === "webgl2" ? fakeWebgl2(this) : null
  if (ctx === null) return null
  contexts.set(this, { type, ctx })
  return ctx
}

class FakeOffscreenCanvas {
  width: number
  height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }
  getContext(type: string): unknown {
    return getContext.call(this, type)
  }
  transferToImageBitmap(): unknown {
    return { width: this.width, height: this.height, close: () => undefined }
  }
  convertToBlob(): Promise<Blob> {
    return Promise.resolve(new Blob([]))
  }
}

let installed: { restore: () => void } | null = null

/** Replace jsdom's canvas with the fakes (idempotent); returns the uninstall function. */
export const installFakeCanvas = (): (() => void) => {
  if (installed !== null) return installed.restore
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  const original = proto.getContext
  proto.getContext = getContext
  // Setting a canvas's width or height resets its 2D state, as in a browser.
  const sizes = ["width", "height"].map((key) => {
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key)!
    Object.defineProperty(HTMLCanvasElement.prototype, key, {
      configurable: true,
      enumerable: d.enumerable ?? true,
      get: d.get!,
      set(this: HTMLCanvasElement, v: number) {
        d.set!.call(this, v)
        const c = contexts.get(this)
        if (c !== undefined && c.type === "2d") (c.ctx as { __reset: () => void }).__reset()
      }
    })
    return [key, d] as const
  })
  const g = globalThis as unknown as { OffscreenCanvas?: unknown }
  const hadOffscreen = g.OffscreenCanvas
  g.OffscreenCanvas = FakeOffscreenCanvas
  const restore = () => {
    proto.getContext = original
    for (const [key, d] of sizes) Object.defineProperty(HTMLCanvasElement.prototype, key, d)
    g.OffscreenCanvas = hadOffscreen
    installed = null
  }
  installed = { restore }
  return restore
}
