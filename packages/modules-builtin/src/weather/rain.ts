/**
 * The next hours of rain from Open-Meteo's 15-minute precipitation (mm in each quarter of an hour), as periods. A pure
 * function: the tool words them. Native 15-minute data exists in central Europe and North America; elsewhere Open-Meteo
 * interpolates from hourly data, so the quarter-hours are less exact there (the doc page says so).
 */
export type Intensity = "dry" | "light" | "moderate" | "heavy"

/** One quarter-hour of rain as a word: under 0.1 mm is dry, to 0.5 mm light (about 2 mm/h), to 1.9 mm moderate, then heavy. */
export const intensityOf = (mm: number): Intensity => (mm < 0.1 ? "dry" : mm < 0.5 ? "light" : mm < 1.9 ? "moderate" : "heavy")

export interface Slot {
  /** Local time of the place as written by the service, "2026-11-18T10:15". */
  readonly time: string
  /** Epoch ms of the start of the quarter-hour. */
  readonly startMs: number
  readonly mm: number
}

export interface Period {
  readonly kind: Intensity
  readonly from: string
  readonly to: string
  readonly minutes: number
  readonly startMs: number
  readonly endMs: number
}

const QUARTER = 15 * 60_000

/**
 * The slots still to come (or in progress) within `windowMs` of `nowMs`, merged into runs of dry and wet. A wet run keeps
 * its strongest intensity. `to` is the end of the last quarter-hour of the run.
 */
export const periodsOf = (slots: ReadonlyArray<Slot>, nowMs: number, windowMs: number): ReadonlyArray<Period> => {
  const seen = slots.filter((s) => s.startMs + QUARTER > nowMs && s.startMs < nowMs + windowMs)
  const out: Array<{ kind: Intensity; slots: Array<Slot> }> = []
  const rank: Record<Intensity, number> = { dry: 0, light: 1, moderate: 2, heavy: 3 }
  for (const slot of seen) {
    const kind = intensityOf(slot.mm)
    const last = out.at(-1)
    if (last !== undefined && (last.kind === "dry") === (kind === "dry")) {
      last.slots.push(slot)
      if (rank[kind] > rank[last.kind]) last.kind = kind
    } else out.push({ kind, slots: [slot] })
  }
  return out.map((run) => {
    const first = run.slots[0]!
    const last = run.slots.at(-1)!
    const endMs = last.startMs + QUARTER
    // The service writes the place's own clock; adding a quarter to that written time (read as UTC) gives the written end.
    const end = new Date(Date.parse(`${last.time}:00Z`) + QUARTER).toISOString().slice(0, 16)
    return { kind: run.kind, from: first.time, to: end, minutes: Math.round((endMs - Math.max(first.startMs, nowMs)) / 60_000), startMs: first.startMs, endMs }
  })
}
