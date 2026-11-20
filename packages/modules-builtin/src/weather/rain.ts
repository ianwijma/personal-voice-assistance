/**
 * The next hours of rain from Open-Meteo's 15-minute precipitation (mm in each quarter of an hour), as periods. Pure
 * functions over instants (the service is asked for epoch timestamps): the tool words them in the place's own zone. Native
 * 15-minute data exists in central Europe and North America; elsewhere Open-Meteo interpolates from hourly data, so the
 * quarter-hours are less exact there (the doc page says so).
 */
export type Intensity = "dry" | "light" | "moderate" | "heavy"

/** One quarter-hour of rain as a word: under 0.1 mm is dry, to 0.5 mm light (about 2 mm/h), to 1.9 mm moderate, then heavy. */
export const intensityOf = (mm: number): Intensity => (mm < 0.1 ? "dry" : mm < 0.5 ? "light" : mm < 1.9 ? "moderate" : "heavy")

export const QUARTER_MS = 15 * 60_000

export interface Slot {
  /** Epoch ms of the start of the quarter-hour. */
  readonly startMs: number
  /** Precipitation in it; `null` when the service does not know. */
  readonly mm: number | null
}

export interface Period {
  readonly kind: Intensity
  readonly startMs: number
  readonly endMs: number
}

/**
 * The quarter-hours that really cover the time from `nowMs`: the one `nowMs` falls in, then each that follows it
 * exactly (no gap, no overlap, no unknown value), until `untilMs` is covered. Returns the time they cover to, which is
 * before `untilMs` when the service did not cover all of it; `undefined` when not even the present quarter is known.
 */
export const coverage = (slots: ReadonlyArray<Slot>, nowMs: number, untilMs: number): { readonly slots: ReadonlyArray<Slot & { readonly mm: number }>; readonly toMs: number } | undefined => {
  const first = slots.findIndex((s) => s.startMs <= nowMs && nowMs < s.startMs + QUARTER_MS)
  if (first < 0) return undefined
  const covered: Array<Slot & { readonly mm: number }> = []
  for (let i = first; i < slots.length; i++) {
    const s = slots[i]!
    if (s.mm === null || !Number.isFinite(s.mm)) break
    if (covered.length > 0 && s.startMs !== covered.at(-1)!.startMs + QUARTER_MS) break
    covered.push({ startMs: s.startMs, mm: s.mm })
    if (s.startMs + QUARTER_MS >= untilMs) break
  }
  if (covered.length === 0) return undefined
  return { slots: covered, toMs: Math.min(untilMs, covered.at(-1)!.startMs + QUARTER_MS) }
}

/**
 * The covered quarter-hours from `nowMs` to `endMs`, merged into runs of dry and wet, each clipped to that interval. A wet
 * run keeps its strongest intensity.
 */
export const periodsOf = (slots: ReadonlyArray<Slot & { readonly mm: number }>, nowMs: number, endMs: number): ReadonlyArray<Period> => {
  const rank: Record<Intensity, number> = { dry: 0, light: 1, moderate: 2, heavy: 3 }
  const out: Array<{ kind: Intensity; startMs: number; endMs: number }> = []
  for (const slot of slots) {
    const from = Math.max(slot.startMs, nowMs)
    const to = Math.min(slot.startMs + QUARTER_MS, endMs)
    if (to <= from) continue
    const kind = intensityOf(slot.mm)
    const last = out.at(-1)
    if (last !== undefined && (last.kind === "dry") === (kind === "dry")) {
      last.endMs = to
      if (rank[kind] > rank[last.kind]) last.kind = kind
    } else out.push({ kind, startMs: from, endMs: to })
  }
  return out
}
