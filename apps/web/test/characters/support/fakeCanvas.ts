/**
 * A recording canvas for jsdom (which has none): `installFakeCanvas()` makes `HTMLCanvasElement.getContext` and a
 * global `OffscreenCanvas` return fakes that accept every call and fold it into a running hash, so two runs can be
 * compared ("did these frames draw the same?") without storing the calls. The 2D fake tracks the transform and the
 * extent of what is filled or stroked on a canvas marked as the stage, for the "stays inside the canvas" check.
 * The WebGL2 fake answers enough for a character to compile, link and draw (every shader compiles); its calls are
 * hashed too.
 *
 * Painted output is recorded apart from the call digest (`paints`, `paintDigest`): only a call that puts pixels on
 * a canvas counts (2D `fill`, `stroke`, `fillRect`, `strokeRect`, `fillText`, `strokeText`, `drawImage`,
 * `putImageData`; WebGL `draw*`), and the paint digest folds, at each paint, the calls since the previous paint
 * and the state the paint is made with (styles, transform, dash; a drawn layer's content; WebGL's last value of
 * each setting and uniform). Calls after the last paint, which show nothing, do not reach it.
 *
 * Only effective painting counts: a `fill` needs a path that can enclose an area (a sub-path of two or more
 * straight segments, a curve, an arc, a rectangle with a size; a single line encloses none), a `stroke` a path with
 * a segment, a rectangle needs a size, text must not be empty, an image draw needs a size, and `globalAlpha` must be
 * above 0. Not a rasteriser: it only keeps plainly empty output from counting.
 *
 * Like a browser, the 2D fake ignores an invalid value for the properties it models: `lineWidth` and `miterLimit`
 * not above 0, `shadowBlur` below 0, `globalAlpha` outside 0 to 1, or any of them not finite, keep the value they
 * had (so a stroke after `lineWidth = 0` is drawn at the previous width).
 *
 * Like a browser, the 2D fake throws for a negative radius: `arc`, `arcTo`, `ellipse` and `createRadialGradient`
 * an `IndexSizeError`, `roundRect` a `RangeError`, and `createRadialGradient` a `TypeError` for a
 * non-finite argument; with a non-finite argument the path calls (including `roundRect`'s radii) do nothing, as in a
 * browser, and are counted (`nonFinite`, which includes `createRadialGradient` and the numbers inside `roundRect`'s
 * radii, once per call).
 */

const FNV = 0x811c9dc5
const fold = (acc: number, n: number): number => Math.imul(acc ^ (n | 0), 0x01000193) >>> 0

/** What one frame (or one run) drew. */
export class Recording {
  calls = 0
  /** Calls that put pixels on a canvas (see the header). */
  paints = 0
  /** 2D geometry calls given a non-finite number (a browser ignores them: the shape is not drawn). */
  nonFinite = 0
  /** Folded at each paint: the calls since the previous paint and the paint's state. */
  paintHash = FNV
  /** The calls since the previous paint. */
  private pending = FNV
  /** A scratch recording for state snapshots: objects with a `__digest` (gradients, layers) count by it. */
  private readonly objects: boolean
  /** While set, `mix` adds to the call digest only (a property set: a paint reads properties by value). */
  quiet = false
  /** When set, every 2D call and property set is also appended here (for tests that look at what was drawn). */
  log: Array<{ readonly name: string; readonly args: ReadonlyArray<unknown> }> | null = null
  hash = 0x811c9dc5
  /** Extent of filled and stroked geometry on the stage canvas, device pixels. */
  minX = Infinity
  minY = Infinity
  maxX = -Infinity
  maxY = -Infinity

  constructor(objects = false) {
    this.objects = objects
  }

  reset(): void {
    this.calls = 0
    this.hash = 0x811c9dc5
    this.paints = 0
    this.nonFinite = 0
    this.paintHash = FNV
    this.pending = FNV
    this.minX = this.minY = Infinity
    this.maxX = this.maxY = -Infinity
  }

  mix(n: number): void {
    let h = this.hash ^ (n | 0)
    h = Math.imul(h, 0x01000193)
    this.hash = h >>> 0
    if (!this.quiet) this.pending = fold(this.pending, n)
  }

  /** One paint, made with the state digest `state`. */
  paint(state: number): void {
    this.paints++
    this.paintHash = fold(fold(this.paintHash, this.pending), state)
    this.pending = FNV
  }

  get paintDigest(): string {
    return this.paintHash.toString(16).padStart(8, "0")
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
    } else if (this.objects && typeof (v as { __digest?: unknown }).__digest === "function") this.mix((v as { __digest: () => number }).__digest())
    else if (this.objects && ArrayBuffer.isView((v as { data?: unknown }).data)) {
      // Image data: a spread sample of its bytes.
      const a = (v as { data: ArrayLike<number> }).data
      const stride = Math.max(1, Math.floor(a.length / 256))
      for (let i = 0; i < a.length; i += stride) this.mix(a[i]!)
      this.mix(a.length)
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

/** A gradient; `__digest` (for paint state only) covers how it was made and its stops. */
const gradient = (rec: Recording, kind: string, args: ReadonlyArray<unknown>) => {
  const own = new Recording(true)
  own.str(kind)
  for (const a of args) own.value(a)
  return {
    addColorStop: (offset: number, color: string) => {
      rec.mix(idOf("addColorStop"))
      rec.value(offset)
      rec.value(color)
      own.value(offset)
      own.value(color)
    },
    __digest: () => own.hash
  }
}

/** What is on each fake canvas, as a digest (for a `drawImage` of it): every paint since it was last cleared. */
const contents = new WeakMap<object, () => number>()

const PAINTS_2D = new Set(["fill", "stroke", "fillRect", "strokeRect", "fillText", "strokeText", "drawImage", "putImageData"])
const PAINTS_GL = new Set(["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"])
/** 2D calls whose numbers are geometry: a non-finite one makes a browser skip the call. */
const GEOMETRY = new Set(["moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "arc", "arcTo", "ellipse", "rect", "roundRect", "fillRect", "strokeRect", "clearRect", "fillText", "strokeText", "translate", "scale", "rotate", "transform", "setTransform", "drawImage", "createRadialGradient"])

const finite = (args: ReadonlyArray<unknown>): boolean => {
  for (const a of args) if (typeof a === "number" && !Number.isFinite(a)) return false
  return true
}
const negativeRadius = (call: string, r: number): never => {
  throw new DOMException(`Failed to execute '${call}' on 'CanvasRenderingContext2D': The radius provided (${r}) is negative.`, "IndexSizeError")
}
/** `roundRect`'s radii as lists of numbers, one per radius: a point-like radius has two (`x` and `y`, 0 if absent). */
const radiusValues = (radii: unknown): ReadonlyArray<ReadonlyArray<number>> => {
  if (radii === undefined) return []
  const list: ReadonlyArray<unknown> = Array.isArray(radii) ? radii : [radii]
  return list.map((r) => (typeof r === "object" && r !== null ? [Number((r as { x?: unknown }).x ?? 0), Number((r as { y?: unknown }).y ?? 0)] : [Number(r)]))
}
/**
 * `roundRect`'s radii, as a browser checks them: 1 to 4 of them, else a `RangeError`. Then each radius in turn: a
 * non-finite value (either coordinate of a point-like one) makes the call return without drawing or throwing, a
 * negative one throws a `RangeError`; so `[-1, NaN]` throws and `[NaN, -1]` does not. True when the call draws.
 */
const checkRadii = (radii: unknown): boolean => {
  if (radii === undefined) return true
  const list = radiusValues(radii)
  if (list.length < 1 || list.length > 4) throw new RangeError(`Failed to execute 'roundRect' on 'CanvasRenderingContext2D': ${list.length} radii provided. Between one and four radii are necessary.`)
  for (const values of list) {
    if (!values.every((v) => Number.isFinite(v))) return false
    for (const v of values) if (v < 0) throw new RangeError(`Failed to execute 'roundRect' on 'CanvasRenderingContext2D': Radius value ${v} is negative.`)
  }
  return true
}
/** Does a geometry call have a non-finite number (for `roundRect`, also inside its radii)? */
const hasNonFinite = (prop: string, args: ReadonlyArray<unknown>): boolean => {
  if (!finite(args)) return true
  if (prop !== "roundRect") return false
  return radiusValues(args[4]).some((values) => values.some((v) => !Number.isFinite(v)))
}

/**
 * The 2D properties whose setter ignores an invalid value, as in a browser (the property keeps its value): the
 * test for a valid one, after the value is converted to a number.
 */
const VALID_NUMBER: { readonly [prop: string]: (v: number) => boolean } = {
  lineWidth: (v) => Number.isFinite(v) && v > 0,
  miterLimit: (v) => Number.isFinite(v) && v > 0,
  shadowBlur: (v) => Number.isFinite(v) && v >= 0,
  globalAlpha: (v) => Number.isFinite(v) && v >= 0 && v <= 1
}

/** A number as the platform converts an argument (`undefined` is NaN, `null` is 0). */
const numeric = (v: unknown): number => (v === undefined ? Number.NaN : Number(v))
/** A finite, non-zero size. */
const sized = (v: unknown): boolean => {
  const n = numeric(v)
  return Number.isFinite(n) && n !== 0
}

interface CanvasLike {
  width: number
  height: number
}

/** Fold a call's arguments into `h` (numbers to 0.1, strings by their characters; objects count as one value). */
const foldArgs = (h: number, args: ReadonlyArray<unknown>): number => {
  for (const a of args) {
    if (typeof a === "number") h = fold(h, Number.isFinite(a) ? Math.round(a * 10) : 0x7fffffff)
    else if (typeof a === "string") {
      for (let i = 0; i < a.length; i++) h = fold(h, a.charCodeAt(i))
      h = fold(h, a.length)
    } else if (typeof a === "boolean") h = fold(h, a ? 1 : 2)
    else h = fold(h, 4)
  }
  return h
}

/** The 2D properties every paint is made with, and those each kind of paint adds. */
const COMMON_STATE = ["globalAlpha", "globalCompositeOperation", "filter", "shadowBlur", "shadowColor", "shadowOffsetX", "shadowOffsetY"]
const TEXT_STATE = ["font", "textAlign", "textBaseline", "direction", "letterSpacing", "wordSpacing", "fontKerning"]
const STROKE_STATE = ["strokeStyle", "lineWidth", "lineCap", "lineJoin", "miterLimit", "lineDashOffset"]
const PAINT_STATE: { readonly [paint: string]: ReadonlyArray<string> } = {
  fill: [...COMMON_STATE, "fillStyle"],
  fillRect: [...COMMON_STATE, "fillStyle"],
  fillText: [...COMMON_STATE, "fillStyle", ...TEXT_STATE],
  stroke: [...COMMON_STATE, ...STROKE_STATE],
  strokeRect: [...COMMON_STATE, ...STROKE_STATE],
  strokeText: [...COMMON_STATE, ...STROKE_STATE, ...TEXT_STATE],
  drawImage: [...COMMON_STATE, "imageSmoothingEnabled", "imageSmoothingQuality"],
  putImageData: []
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
  // What the current path can paint (since `beginPath`): whether it has a current point, the straight segments of
  // the current sub-path, and how many parts can put pixels on a fill (an area) and on a stroke (a line). A single
  // straight segment encloses no area: a sub-path needs two (three points) before a fill can show it. A curve or an
  // arc can enclose an area by itself. A rectangle of no width and height adds neither; one of no width or no
  // height can still be stroked.
  let hasPoint = false
  let subLines = 0
  let fillSegs = 0
  let strokeSegs = 0
  // The straight-only sub-path in progress: its first point, the direction to the first point that differs from it,
  // and whether a point has been seen off that line. Collinear points enclose no area, so a straight-only sub-path
  // fills only once `offLine` is set. This is decided in the coordinates the path was given in, ignoring the
  // transform: an affine transform keeps collinear points collinear (a degenerate one only makes more paths flat,
  // which this does not try to notice).
  let startX: number | undefined
  let startY: number | undefined
  let dirX = 0
  let dirY = 0
  let hasDir = false
  let offLine = false
  const newPath = () => {
    hasPoint = false
    subLines = 0
    fillSegs = 0
    strokeSegs = 0
    startX = undefined
    startY = undefined
    hasDir = false
    offLine = false
  }
  /** A new sub-path at a point (`moveTo`, and after `rect`, `roundRect` and `closePath`). */
  const subPath = (x?: number, y?: number) => {
    hasPoint = true
    subLines = 0
    startX = x
    startY = y
    dirX = 0
    dirY = 0
    hasDir = false
    offLine = false
  }
  /** A curved segment (a curve, an arc): strokable, and able to enclose an area. */
  const curve = () => {
    hasPoint = true
    subLines++
    fillSegs++
    strokeSegs++
  }
  /** The sub-path now holds a part that encloses area, once. */
  const markOffLine = () => {
    if (offLine) return
    offLine = true
    fillSegs++
  }
  /**
   * A straight segment from the current point to (x, y); with no current point, the call only starts a sub-path (as
   * a browser does). Without a known end point (a flat ellipse) the segment counts as off the line from the second
   * segment on, as the conservative answer.
   */
  const lineSegment = (x?: number, y?: number) => {
    if (!hasPoint) return subPath(x, y)
    subLines++
    strokeSegs++
    if (offLine) return
    if (x === undefined || y === undefined || startX === undefined || startY === undefined) {
      if (subLines >= 2) markOffLine()
      return
    }
    const dx = x - startX
    const dy = y - startY
    // Points closer than this to a line are on it. Relative to the size of the shape (offsets from its first point),
    // not to where it lies: a thin triangle far from the origin still has area.
    const tol = 1e-9 * Math.max(1, Math.abs(dx), Math.abs(dy), Math.abs(dirX), Math.abs(dirY))
    if (!hasDir) {
      // A point repeated at the start makes no direction.
      if (Math.hypot(dx, dy) > tol) {
        dirX = dx
        dirY = dy
        hasDir = true
      }
      return
    }
    // Distance of the point from the line through the start along the direction.
    const dist = Math.abs(dirX * dy - dirY * dx) / Math.hypot(dirX, dirY)
    if (dist > tol) markOffLine()
  }
  const rectSegment = (x: number, y: number, w: number, h: number) => {
    subPath(x, y)
    if (sized(w) && sized(h)) fillSegs++
    if (sized(w) || sized(h)) strokeSegs++
  }
  // Paint state: the properties this kind of paint uses (wherever they were set, this frame or before) and the
  // transform; for `fill` and `stroke` the path since `beginPath`; and what a drawn canvas holds (every paint on it
  // since it was last cleared).
  const scratch = new Recording(true)
  let pathHash = FNV
  let content = FNV
  contents.set(canvas, () => content)
  const stateDigest = (prop: string): number => {
    scratch.reset()
    for (const k of PAINT_STATE[prop] ?? COMMON_STATE) {
      const v = props.get(k)
      if (v === undefined) continue
      scratch.str(k)
      scratch.value(v)
    }
    for (const v of m) scratch.value(v)
    if (prop === "stroke" || prop === "strokeRect" || prop === "strokeText") scratch.value(dash)
    return scratch.hash
  }
  /** Would this paint put pixels on a canvas? Conservative: only plainly empty output (nothing to fill or stroke, no size, no text, no alpha) does not count. */
  const effective = (prop: string, args: ReadonlyArray<unknown>): boolean => {
    if (prop === "putImageData") {
      const d = args[0] as { width?: unknown; height?: unknown } | null | undefined
      return sized(d?.width) && sized(d?.height)
    }
    // Only a valid `globalAlpha` is ever stored (see `VALID_NUMBER`), so this is 0 or above.
    if (Number(props.get("globalAlpha") ?? 1) <= 0) return false
    const given = typeof args[0] === "object" && args[0] !== null // fill(path) / stroke(path): a Path2D we do not track
    switch (prop) {
      case "fill":
        return fillSegs > 0 || given
      case "stroke":
        return strokeSegs > 0 || given
      case "fillRect":
        return finite(args) && sized(args[2]) && sized(args[3])
      case "strokeRect":
        return finite(args) && (sized(args[2]) || sized(args[3]))
      case "fillText":
        return finite(args) && String(args[0] ?? "").length > 0
      case "strokeText":
        return finite(args) && String(args[0] ?? "").length > 0
      case "drawImage": {
        if (!finite(args)) return false
        if (args.length >= 9) return sized(args[3]) && sized(args[4]) && sized(args[7]) && sized(args[8])
        if (args.length >= 5) return sized(args[3]) && sized(args[4])
        const src = args[0] as { width?: unknown; height?: unknown } | null | undefined
        return (src?.width === undefined || sized(src.width)) && (src?.height === undefined || sized(src.height))
      }
      default:
        return true
    }
  }
  const paintNow = (id: number, prop: string, args: ReadonlyArray<unknown>) => {
    let h = fold(stateDigest(prop), id)
    if (prop === "fill" || prop === "stroke") h = fold(h, pathHash)
    h = foldArgs(h, args)
    if (prop === "drawImage") {
      const src = args[0]
      const c = typeof src === "object" && src !== null ? contents.get(src) : undefined
      if (c !== undefined) h = fold(h, c())
    } else if (prop === "putImageData") {
      scratch.reset()
      scratch.value(args[0])
      h = fold(h, scratch.hash)
    }
    rec.paint(h)
    content = fold(content, h)
  }
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
      newPath()
      pathHash = FNV
      content = FNV
    },
    clearRect: () => {
      content = FNV
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
    beginPath: () => {
      resetPath()
      newPath()
    },
    moveTo: ((x: number, y: number) => {
      point(x, y)
      if (finite([x, y])) subPath(x, y)
    }) as never,
    closePath: () => {
      if (hasPoint) subPath(startX, startY)
    },
    lineTo: ((x: number, y: number) => {
      point(x, y)
      if (finite([x, y])) lineSegment(x, y)
    }) as never,
    quadraticCurveTo: ((cx: number, cy: number, x: number, y: number) => {
      point(x, y)
      if (finite([cx, cy, x, y])) curve()
    }) as never,
    bezierCurveTo: ((a: number, b: number, c: number, d: number, x: number, y: number) => {
      point(x, y)
      if (finite([a, b, c, d, x, y])) curve()
    }) as never,
    arcTo: ((x1: number, y1: number, x2: number, y2: number, r: number) => {
      if (!finite([x1, y1, x2, y2, r])) return
      if (r < 0) negativeRadius("arcTo", r)
      point(x1, y1)
      point(x2, y2)
      // Without a current point it only starts a sub-path; a radius of 0 is a straight line to (x1, y1).
      if (!hasPoint) subPath(x1, y1)
      else if (r > 0) curve()
      else lineSegment(x1, y1)
    }) as never,
    arc: ((x: number, y: number, r: number, a0: number, a1: number, ccw = false) => {
      if (!finite([x, y, r, a0, a1])) return
      if (r < 0) negativeRadius("arc", r)
      arcPoints(x, y, r, r, 0, a0, a1, ccw)
      // A radius of 0 is a point: only the line to it from the current point.
      if (r > 0) curve()
      else lineSegment(x, y)
    }) as never,
    ellipse: ((x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false) => {
      if (!finite([x, y, rx, ry, rot, a0, a1])) return
      if (rx < 0) negativeRadius("ellipse", rx)
      if (ry < 0) negativeRadius("ellipse", ry)
      arcPoints(x, y, rx, ry, rot, a0, a1, ccw)
      if (rx > 0 && ry > 0) curve()
      else {
        // Flat: a line to it from the current point, and a line along it when one radius is above 0.
        lineSegment()
        if (rx > 0 || ry > 0) strokeSegs++
      }
    }) as never,
    clip: () => {
      if (pMinX === Infinity) return
      clip = [Math.max(clip[0], pMinX), Math.max(clip[1], pMinY), Math.min(clip[2], pMaxX), Math.min(clip[3], pMaxY)]
    },
    rect: ((x: number, y: number, w: number, h: number) => {
      box(x, y, w, h)
      if (finite([x, y, w, h])) rectSegment(x, y, w, h)
    }) as never,
    roundRect: ((x: number, y: number, w: number, h: number, radii?: unknown) => {
      if (!finite([x, y, w, h])) return
      if (!checkRadii(radii)) return
      box(x, y, w, h)
      rectSegment(x, y, w, h)
    }) as never,
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
    createLinearGradient: ((...a: Array<unknown>) => gradient(rec, "linear", a)) as never,
    createRadialGradient: ((x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) => {
      if (![x0, y0, r0, x1, y1, r1].every((v) => Number.isFinite(numeric(v)))) throw new TypeError("Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.")
      if (r0 < 0 || r1 < 0) throw new DOMException(`Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The ${r0 < 0 ? "r0" : "r1"} provided is less than 0.`, "IndexSizeError")
      return gradient(rec, "radial", [x0, y0, r0, x1, y1, r1])
    }) as never,
    createConicGradient: ((...a: Array<unknown>) => gradient(rec, "conic", a)) as never,
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
        const paints = PAINTS_2D.has(prop)
        const geometry = GEOMETRY.has(prop)
        const begins = prop === "beginPath"
        fn = (...args: Array<unknown>) => {
          rec.calls++
          rec.mix(id)
          for (const a of args) rec.value(a)
          rec.log?.push({ name: prop, args })
          if (geometry && hasNonFinite(prop, args)) rec.nonFinite++
          const out = own?.(...args)
          if (paints) {
            if (effective(prop, args)) paintNow(id, prop, args)
          } else if (begins) pathHash = FNV
          else pathHash = foldArgs(fold(pathHash, id), args)
          return out
        }
        fns.set(prop, fn)
      }
      return fn
    },
    set(_t, prop, value) {
      if (typeof prop === "symbol") return true
      // An invalid value is ignored, as in a browser; the assignment still reaches the call digest.
      const valid = VALID_NUMBER[prop]
      if (valid === undefined || valid(Number(value))) props.set(prop, value)
      // In the call digest as before, but not in what the next paint folds: a paint counts a property by its value.
      rec.quiet = true
      rec.mix(idOf(prop))
      rec.value(value)
      rec.quiet = false
      rec.log?.push({ name: `=${prop}`, args: [value] })
      return true
    }
  })
  return ctx as unknown as CanvasRenderingContext2D
}

/** A WebGL2 context that accepts everything: shaders compile, programs link, draws are hashed. */
export const fakeWebgl2 = (canvas: CanvasLike, rec: Recording = recording): WebGL2RenderingContext => {
  const fns = new Map<string, (...a: Array<unknown>) => unknown>()
  // Paint state: the last arguments of every setting call, by call and target (a uniform by its name).
  const settings = new Map<string, ReadonlyArray<unknown>>()
  const scratch = new Recording(true)
  let content = FNV
  contents.set(canvas, () => content)
  const keyOf = (prop: string, a0: unknown): string =>
    `${prop}:${typeof a0 === "object" && a0 !== null && "uniform" in a0 ? String((a0 as { uniform: unknown }).uniform) : typeof a0 === "number" || typeof a0 === "string" ? String(a0) : ""}`
  const paintNow = (id: number, args: ReadonlyArray<unknown>) => {
    scratch.reset()
    for (const [k, v] of settings) {
      scratch.str(k)
      for (const a of v) scratch.value(a)
    }
    const h = foldArgs(fold(scratch.hash, id), args)
    rec.paint(h)
    content = fold(content, h)
  }
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
        const paints = PAINTS_GL.has(prop)
        const setting = !paints && !/^(get|create|is|check)/.test(prop)
        fn = (...args: Array<unknown>) => {
          rec.calls++
          rec.mix(id)
          for (const a of args) rec.value(a)
          if (paints) paintNow(id, args)
          else if (setting) settings.set(keyOf(prop, args[0]), args)
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
