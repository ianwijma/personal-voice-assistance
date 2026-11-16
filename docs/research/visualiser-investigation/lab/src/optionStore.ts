/**
 * The viewer's option values, per design: validated, cached as `ResolvedOptions`, persisted through an
 * injected key-value (localStorage in the page, a fake in tests), and exportable as URL pairs or JSON.
 * Only values that differ from the default are kept.
 */
import type { Design, OptionSpec } from "./contract.ts"
import { COMMON_OPTIONS, isDefault, resolveAll, validateValue, valueToString, type ResolvedOptions } from "./options.ts"

export interface KeyValue {
  read(): string | null
  write(text: string): void
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const EMPTY: ReadonlyArray<OptionSpec> = []

export class OptionStore {
  private raw = new Map<string, Record<string, unknown>>()
  private readonly cache = new Map<string, ResolvedOptions>()
  private version = 0
  private readonly listeners = new Set<(design: Design) => void>()

  private readonly kv: KeyValue | null

  constructor(kv: KeyValue | null) {
    this.kv = kv
    try {
      const text = kv?.read() ?? null
      const data: unknown = text === null ? null : JSON.parse(text)
      if (isPlain(data)) for (const [id, v] of Object.entries(data)) if (isPlain(v)) this.raw.set(id, { ...v })
    } catch {
      // storage unreadable or corrupt: start from defaults
    }
  }

  /** All specs shown for a design: the common ones first. */
  specs(design: Design): ReadonlyArray<OptionSpec> {
    return [...COMMON_OPTIONS, ...(design.options ?? EMPTY)]
  }

  resolved(design: Design): ResolvedOptions {
    let r = this.cache.get(design.id)
    if (r === undefined) {
      r = resolveAll(design.options, this.raw.get(design.id), ++this.version)
      this.cache.set(design.id, r)
    }
    return r
  }

  /** The current validated value of one control (design option or common "$…" setting). */
  value(design: Design, id: string): number | boolean | string | undefined {
    const r = this.resolved(design)
    return id.startsWith("$") ? r.common[id] : r.values[id]
  }

  isCustomised(design: Design): boolean {
    return this.specs(design).some((s) => !isDefault(s, this.value(design, s.id)))
  }

  set(design: Design, id: string, value: unknown): void {
    const spec = this.specs(design).find((s) => s.id === id)
    if (spec === undefined) return
    const v = validateValue(spec, value)
    if (v === this.value(design, id)) return
    const mine = { ...(this.raw.get(design.id) ?? {}) }
    if (isDefault(spec, v)) delete mine[id]
    else mine[id] = v
    this.commit(design, mine)
  }

  reset(design: Design): void {
    if (this.raw.has(design.id)) this.commit(design, {})
  }

  /** Replace the design's values by those in the URL (`opt.<id>=<value>` with the prefix removed). */
  applyUrl(design: Design, pairs: { readonly [id: string]: string }): void {
    const mine: Record<string, unknown> = {}
    for (const s of this.specs(design)) {
      if (!Object.hasOwn(pairs, s.id)) continue
      const v = validateValue(s, pairs[s.id])
      if (!isDefault(s, v)) mine[s.id] = v
    }
    this.commit(design, mine)
  }

  /** `[id, text]` for every value that differs from its default, in spec order. */
  urlPairs(design: Design): Array<[string, string]> {
    const out: Array<[string, string]> = []
    for (const s of this.specs(design)) {
      const v = this.value(design, s.id)
      if (v !== undefined && !isDefault(s, v)) out.push([s.id, valueToString(v)])
    }
    return out
  }

  /** `{ design, options }` with every value of the design's own options and the common settings, complete. */
  json(design: Design): string {
    const r = this.resolved(design)
    return JSON.stringify({ design: design.id, options: { ...r.common, ...r.values } })
  }

  onChange(fn: (design: Design) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private commit(design: Design, mine: Record<string, unknown>): void {
    if (Object.keys(mine).length === 0) this.raw.delete(design.id)
    else this.raw.set(design.id, mine)
    this.cache.delete(design.id)
    this.persist()
    for (const l of this.listeners) l(design)
  }

  private persist(): void {
    try {
      this.kv?.write(JSON.stringify(Object.fromEntries(this.raw)))
    } catch {
      // storage full or blocked: the values still apply for this page view
    }
  }
}
