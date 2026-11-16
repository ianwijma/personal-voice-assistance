/**
 * The lab page: gallery, detail view with feature readout and reaction matrix, prior art.
 * Plain DOM; every animated thing goes through the Engine's single rAF loop.
 *
 * URL choices (query string, or after the hash: `#<design>?mode=hearing&theme=light`):
 *   design=<id>  mode=auto|idle|listening|hearing|thinking|speaking  theme=auto|dark|light
 *   matrix=modes|loudness|voice|delivery|assistant  reduced=1
 *   user=<register>,<loudness>,<delivery>  agent=<register>,<loudness>,<delivery>
 *   opt.<id>=<value>  one design option (common settings: opt.$you, opt.$voice, opt.$sensitivity);
 *   the page keeps these in the hash as you change the "Customise" panel
 */
import { BAND_COUNT, MODES, type Design, type Mode, type OptionSpec, type PriorArt, type VoiceFeatures } from "./contract.ts"
import { Conversation, type Pin } from "./driver.ts"
import { Engine, type Stage } from "./engine.ts"
import { OptionStore } from "./optionStore.ts"
import { isDefault, isHexColor, PALETTE_KEYS, resolveColor, rgbToHex } from "./options.ts"
import { cssVariables, PALETTES, type Theme } from "./palette.ts"
import priorArt from "./priorArt.ts"
import { ENTRIES, FAMILY_LABEL, type Entry } from "./registry.ts"
import { decodeFile, MicFeed, Monitor } from "./sources.ts"
import {
  DELIVERIES,
  DELIVERY_LABEL,
  LOUDNESS_LABEL,
  LOUDNESSES,
  REGISTER_LABEL,
  REGISTERS,
  renderVoice,
  type Delivery,
  type Loudness,
  type Register,
  type VoiceClip,
  type VoiceSpec
} from "./synth.ts"

// ---------------------------------------------------------------------------------------------
// Settings

type MatrixTab = "modes" | "loudness" | "voice" | "delivery" | "assistant"
const MATRIX_TABS: ReadonlyArray<readonly [MatrixTab, string]> = [
  ["modes", "Modes"],
  ["loudness", "Loudness"],
  ["voice", "Voice"],
  ["delivery", "Delivery"],
  ["assistant", "Assistant speaking"]
]
interface VoiceChoice {
  register: Register
  loudness: Loudness
  delivery: Delivery
}
const USER_SEED = 11
const AGENT_SEED = 23

const settings = {
  pin: "auto" as Pin,
  user: { register: "mid", loudness: "normal", delivery: "normal" } as VoiceChoice,
  agent: { register: "high", loudness: "normal", delivery: "normal" } as VoiceChoice,
  reduced: false,
  theme: "auto" as "auto" | Theme,
  matrix: "modes" as MatrixTab
}

const readParams = (): { design: string | null } => {
  const q = new URLSearchParams(location.search)
  const hash = location.hash.replace(/^#/, "")
  const qi = hash.indexOf("?")
  const hq = new URLSearchParams(qi >= 0 ? hash.slice(qi + 1) : "")
  const get = (k: string) => hq.get(k) ?? q.get(k)
  const mode = get("mode")
  if (mode === "auto" || MODES.includes(mode as Mode)) settings.pin = mode as Pin
  const theme = get("theme")
  if (theme === "dark" || theme === "light" || theme === "auto") settings.theme = theme
  const matrix = get("matrix")
  if (MATRIX_TABS.some(([k]) => k === matrix)) settings.matrix = matrix as MatrixTab
  if (get("reduced") === "1") settings.reduced = true
  const voice = (k: string, into: VoiceChoice) => {
    for (const part of (get(k) ?? "").split(",")) {
      if (REGISTERS.includes(part as Register)) into.register = part as Register
      else if (LOUDNESSES.includes(part as Loudness)) into.loudness = part as Loudness
      else if (DELIVERIES.includes(part as Delivery)) into.delivery = part as Delivery
    }
  }
  voice("user", settings.user)
  voice("agent", settings.agent)
  const fromHash = (qi >= 0 ? hash.slice(0, qi) : hash).trim()
  return { design: fromHash !== "" ? decodeURIComponent(fromHash) : q.get("design") }
}
let initialDesign = readParams().design

// ---------------------------------------------------------------------------------------------
// Option values (the "Customise" panel's data): per design, kept in localStorage and mirrored in the URL hash

const STORAGE_KEY = "pva-visualiser-lab:options:v1"
const store = new OptionStore({
  read: () => localStorage.getItem(STORAGE_KEY),
  write: (text) => localStorage.setItem(STORAGE_KEY, text)
})
/** Re-reads the store into the open panel's controls (set while a detail view is shown). */
let panelRefresh: (() => void) | null = null

// ---------------------------------------------------------------------------------------------
// Theme and motion

const root = document.getElementById("lab")!
const schemeQuery = matchMedia("(prefers-color-scheme: light)")
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)")
const theme = (): Theme => (settings.theme === "auto" ? (schemeQuery.matches ? "light" : "dark") : settings.theme)
const applyTheme = () => {
  const t = theme()
  root.dataset.theme = t
  root.setAttribute("style", cssVariables(t))
  root.style.colorScheme = t
  panelRefresh?.()
}
schemeQuery.addEventListener("change", () => {
  applyTheme()
  renderControls()
})
motionQuery.addEventListener("change", () => renderControls())
applyTheme()

const engine = new Engine({ palette: () => PALETTES[theme()], reducedMotion: () => settings.reduced || motionQuery.matches, options: (d) => store.resolved(d) })

// ---------------------------------------------------------------------------------------------
// Voices and the shared conversation

let userFile: VoiceClip | null = null
let agentFile: VoiceClip | null = null
let mic: MicFeed | null = null
let monitor: Monitor | null = null
let status = ""

const spec = (v: VoiceChoice, seed: number, over: Partial<VoiceChoice> = {}): VoiceSpec => ({ ...v, ...over, seed })
const userClip = (over?: Partial<VoiceChoice>) => (over === undefined && userFile !== null ? userFile : renderVoice(spec(settings.user, USER_SEED, over)))
const agentClip = (over?: Partial<VoiceChoice>) => (over === undefined && agentFile !== null ? agentFile : renderVoice(spec(settings.agent, AGENT_SEED, over)))

const shared = new Conversation({ pin: settings.pin, user: userClip(), agent: agentClip() })

const voicesChanged = () => {
  shared.setUserClip(userClip())
  shared.setAgentClip(agentClip())
  if (view.kind === "detail") buildMatrix()
}

// ---------------------------------------------------------------------------------------------
// DOM helpers

type Child = Node | string | null | undefined | false
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | EventListener> = {}, ...children: ReadonlyArray<Child>): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v)
    else if (v === true) el.setAttribute(k, "")
    else if (v !== false) el.setAttribute(k, v)
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}
const label = (text: string, cls = "") => h("span", { class: `label ${cls}`.trim() }, text)
const MODE_LABEL: { readonly [M in Mode]: string } = { idle: "Idle", listening: "Listening", hearing: "Hearing", thinking: "Thinking", speaking: "Speaking" }

const segmented = <T extends string>(name: string, options: ReadonlyArray<readonly [T, string]>, value: T, onPick: (v: T) => void) =>
  h(
    "div",
    { class: "seg", role: "radiogroup", "aria-label": name },
    ...options.map(([v, text]) =>
      h("button", { type: "button", role: "radio", "aria-checked": v === value ? "true" : "false", class: v === value ? "on" : "", onclick: () => onPick(v) }, text)
    )
  )

const select = <T extends string>(name: string, options: ReadonlyArray<readonly [T, string]>, value: T, onPick: (v: T) => void) => {
  const s = h("select", { "aria-label": name, onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value as T) }, ...options.map(([v, text]) => h("option", { value: v, ...(v === value ? { selected: true } : {}) }, text)))
  return s
}

const fmtCost = (c: { mean: number; worst: number } | null) => (c === null ? "– ms" : `${c.mean.toFixed(2)} ms avg · ${c.worst.toFixed(2)} max`)

// ---------------------------------------------------------------------------------------------
// Controls

const controls = h("div", { class: "controls" })
const fileInput = (onFile: (f: File) => void) => {
  const input = h("input", { type: "file", accept: "audio/*", hidden: true }) as HTMLInputElement
  input.addEventListener("change", () => {
    const f = input.files?.[0]
    if (f !== undefined) onFile(f)
  })
  return input
}

const loadFile = async (file: File, side: "user" | "agent") => {
  status = `Decoding ${file.name}…`
  renderControls()
  try {
    const clip = await decodeFile(file)
    if (side === "user") userFile = clip
    else agentFile = clip
    status = `${file.name}: ${clip.phrases.length} phrase${clip.phrases.length === 1 ? "" : "s"}, ${(clip.samples.length / clip.sampleRate).toFixed(1)} s`
    voicesChanged()
  } catch (e) {
    status = `Could not decode ${file.name}: ${e instanceof Error ? e.message : String(e)}`
  }
  renderControls()
}

const voiceRow = (who: "user" | "agent") => {
  const v = settings[who]
  const set = (patch: Partial<VoiceChoice>) => {
    Object.assign(v, patch)
    if (who === "user") userFile = null
    else agentFile = null
    voicesChanged()
    renderControls()
  }
  const file = who === "user" ? userFile : agentFile
  const input = fileInput((f) => void loadFile(f, who))
  return h(
    "div",
    { class: "row" },
    label(who === "user" ? "You" : "Assistant", who === "user" ? "you" : "voice"),
    select(`${who} register`, REGISTERS.map((r) => [r, REGISTER_LABEL[r]] as const), v.register, (register) => set({ register })),
    select(`${who} loudness`, LOUDNESSES.map((r) => [r, LOUDNESS_LABEL[r]] as const), v.loudness, (loudness) => set({ loudness })),
    select(`${who} delivery`, DELIVERIES.map((r) => [r, DELIVERY_LABEL[r]] as const), v.delivery, (delivery) => set({ delivery })),
    who === "user" &&
      h(
        "button",
        { type: "button", class: mic !== null ? "on" : "", "aria-pressed": mic !== null ? "true" : "false", onclick: () => void toggleMic() },
        mic !== null ? "Microphone on" : "Use microphone"
      ),
    input,
    h("button", { type: "button", title: "Use an audio file for this voice (or drop one on the page)", onclick: () => input.click() }, file !== null ? `File: ${file.label}` : "Audio file…"),
    file !== null &&
      h(
        "button",
        {
          type: "button",
          "aria-label": "Back to the simulated voice",
          onclick: () => {
            if (who === "user") userFile = null
            else agentFile = null
            voicesChanged()
            renderControls()
          }
        },
        "×"
      )
  )
}

const toggleMic = async () => {
  if (mic !== null) {
    mic.close()
    mic = null
    shared.setMic(null)
    status = ""
  } else {
    try {
      mic = await MicFeed.open()
      shared.setMic(mic)
      status = `Microphone at ${mic.sampleRate} Hz: in Auto the loop follows your voice.`
    } catch (e) {
      status = `Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  renderControls()
}

const toggleHear = () => {
  if (monitor !== null) {
    monitor.close()
    monitor = null
  } else monitor = new Monitor()
  renderControls()
}

function renderControls(): void {
  const sysReduced = motionQuery.matches
  controls.replaceChildren(
    h(
      "div",
      { class: "row" },
      label("Mode"),
      segmented("Mode", [["auto", "Auto"], ...MODES.map((m) => [m, MODE_LABEL[m]] as const)], settings.pin, (pin) => {
        settings.pin = pin
        shared.setPin(pin)
        renderControls()
      })
    ),
    voiceRow("user"),
    voiceRow("agent"),
    h(
      "div",
      { class: "row" },
      label("View"),
      h(
        "button",
        {
          type: "button",
          class: settings.reduced || sysReduced ? "on" : "",
          "aria-pressed": settings.reduced || sysReduced ? "true" : "false",
          title: sysReduced ? "Your system asks for reduced motion" : "Simulate prefers-reduced-motion",
          onclick: () => {
            settings.reduced = !settings.reduced
            renderControls()
          }
        },
        sysReduced ? "Reduced motion (system)" : "Reduced motion"
      ),
      segmented("Theme", [["auto", "Auto"], ["dark", "Dark"], ["light", "Light"]] as const, settings.theme, (t) => {
        settings.theme = t
        applyTheme()
        renderControls()
      }),
      view.kind === "detail" &&
        h("button", { type: "button", class: monitor !== null ? "on" : "", "aria-pressed": monitor !== null ? "true" : "false", onclick: toggleHear }, monitor !== null ? "Hearing it" : "Hear it"),
      status !== "" && h("span", { class: "status" }, status)
    )
  )
}

// Drop an audio file anywhere on the lab: it becomes your voice.
root.addEventListener("dragover", (e) => {
  e.preventDefault()
  root.classList.add("dropping")
})
root.addEventListener("dragleave", () => root.classList.remove("dropping"))
root.addEventListener("drop", (e) => {
  e.preventDefault()
  root.classList.remove("dropping")
  const f = e.dataTransfer?.files[0]
  if (f !== undefined) void loadFile(f, "user")
})

// ---------------------------------------------------------------------------------------------
// Views

type View = { kind: "gallery" } | { kind: "detail"; design: Design; main: Stage | null }
let view: View = { kind: "gallery" }
const main = h("main", { class: "view" })
/** Per-frame UI updates of the current view, run from the engine tick. */
let tickers: Array<() => void> = []
let tickCount = 0

engine.onTick = () => {
  tickCount++
  for (const t of tickers) t()
  for (const t of matrixTickers) t()
  if (monitor !== null) monitor.follow(view.kind === "detail" ? shared.audible : null)
}

const designLink = (id: string) => `#${encodeURIComponent(id)}`

const tile = (entry: Entry): HTMLElement => {
  const stageHost = h("div", { class: "tile-stage" })
  if (entry.design === undefined) {
    stageHost.append(h("div", { class: "stage-overlay", "data-kind": "error" }, entry.error))
    return h("div", { class: "tile broken" }, stageHost, h("div", { class: "tile-meta" }, h("div", { class: "tile-head" }, h("span", { class: "name" }, `${entry.file}.ts`), label("Error", "danger")), h("p", { class: "summary" }, "This design did not load.")))
  }
  const d = entry.design
  const modeEl = label(MODE_LABEL[shared.mode], "mode")
  const costEl = label("– ms", "cost")
  const el = h(
    "a",
    { class: "tile", href: designLink(d.id), "aria-label": `${d.name}: open` },
    stageHost,
    h("div", { class: "tile-meta" }, h("div", { class: "tile-head" }, h("span", { class: "name" }, d.name), h("span", { class: "tile-tags" }, store.isCustomised(d) && label("customised", "custom"), modeEl)), h("p", { class: "summary" }, d.summary), costEl)
  )
  const stage = engine.add(stageHost, d, shared)
  let shownMode: Mode | null = null
  tickers.push(() => {
    if (shared.mode !== shownMode) {
      shownMode = shared.mode
      modeEl.textContent = MODE_LABEL[shownMode]
      modeEl.dataset.mode = shownMode
    }
    if (tickCount % 15 === 0) {
      const c = stage.cost()
      costEl.textContent = stage.error !== null ? "failed" : fmtCost(c)
      costEl.classList.toggle("over", c !== null && c.mean > 2)
    }
  })
  return el
}

const FORM_LABEL: { readonly [F in PriorArt["form"]]: string } = {
  waveform: "Waveforms",
  orb: "Orbs",
  "dots-bars": "Dots and bars",
  "edge-light": "Edge light",
  "light-ring": "Light rings",
  particles: "Particles",
  face: "Faces",
  eyes: "Eyes",
  avatar: "Avatars",
  text: "Text",
  other: "Other"
}

const priorArtSection = (): HTMLElement | null => {
  if (priorArt.length === 0) return null
  const groups = new Map<PriorArt["form"], Array<PriorArt>>()
  for (const p of priorArt) groups.set(p.form, [...(groups.get(p.form) ?? []), p])
  return h(
    "section",
    { class: "prior-art" },
    h("h2", { class: "label section-title" }, `Prior art · ${priorArt.length}`),
    ...(Object.keys(FORM_LABEL) as Array<PriorArt["form"]>)
      .filter((f) => groups.has(f))
      .map((f) =>
        h(
          "div",
          { class: "pa-group" },
          h("h3", { class: "label" }, FORM_LABEL[f]),
          h(
            "div",
            { class: "pa-grid" },
            ...groups.get(f)!.map((p) =>
              h(
                "article",
                { class: "pa" },
                h("div", { class: "pa-head" }, h("span", { class: "name" }, p.product), label(`${p.maker} · ${p.era}`, "faint")),
                h("p", {}, p.look),
                h("dl", {}, h("dt", { class: "label" }, "States"), h("dd", {}, p.states), h("dt", { class: "label" }, "Driven by"), h("dd", {}, p.drivenBy), h("dt", { class: "label" }, "Take"), h("dd", {}, p.takeaway)),
                p.sources.length > 0 &&
                  h(
                    "p",
                    { class: "sources" },
                    ...p.sources.flatMap((s, i) => [i > 0 ? " · " : "", /^https?:\/\//.test(s) ? h("a", { href: s, target: "_blank", rel: "noopener noreferrer" }, s.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)) : s])
                  )
              )
            )
          )
        )
      )
  )
}

const renderGallery = () => {
  const families = new Map<string, Array<Entry>>()
  for (const e of ENTRIES) {
    const f = e.design?.family ?? "broken"
    families.set(f, [...(families.get(f) ?? []), e])
  }
  const sections = [...families].map(([family, entries]) =>
    h("section", { class: "family" }, h("h2", { class: "label section-title" }, `${family === "broken" ? "Failed to load" : FAMILY_LABEL[family as Design["family"]]} · ${entries.length}`), h("div", { class: "grid" }, ...entries.map(tile)))
  )
  main.replaceChildren(
    h("p", { class: "intro" }, `${ENTRIES.length} design${ENTRIES.length === 1 ? "" : "s"}, all following one simulated conversation. Click one for its controls, feature readout and reaction matrix. Budget: 2 ms per frame.`),
    ...(ENTRIES.length === 0 ? [h("p", { class: "empty" }, "No designs yet: add src/designs/<id>.ts.")] : sections),
    priorArtSection() ?? ""
  )
}

// Reaction matrix ------------------------------------------------------------------------------

let matrixStages: Array<Stage> = []
let matrixTickers: Array<() => void> = []
const matrixStrip = h("div", { class: "strip" })
const matrixTabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Reaction matrix" })

const matrixCells = (): ReadonlyArray<{ label: string; pin: Mode; user: VoiceClip; agent: VoiceClip }> => {
  const u = userClip()
  const a = agentClip()
  switch (settings.matrix) {
    case "modes":
      return MODES.map((m) => ({ label: MODE_LABEL[m], pin: m, user: u, agent: a }))
    case "loudness":
      return LOUDNESSES.map((l) => ({ label: LOUDNESS_LABEL[l], pin: "hearing", user: userClip({ loudness: l }), agent: a }))
    case "voice":
      return REGISTERS.map((r) => ({ label: REGISTER_LABEL[r], pin: "hearing", user: userClip({ register: r }), agent: a }))
    case "delivery":
      return (["slow-flat", "fast-excited", "questions", "hesitant"] as const).map((d) => ({ label: DELIVERY_LABEL[d], pin: "hearing", user: userClip({ delivery: d }), agent: a }))
    case "assistant":
      return (["soft", "normal", "loud"] as const).map((l) => ({ label: `Assistant ${LOUDNESS_LABEL[l].toLowerCase()}`, pin: "speaking", user: u, agent: agentClip({ loudness: l }) }))
  }
}

function buildMatrix(): void {
  if (view.kind !== "detail") return
  const design = view.design
  for (const s of matrixStages) engine.remove(s)
  matrixStages = []
  matrixTickers = []
  matrixTabs.replaceChildren(
    ...MATRIX_TABS.map(([k, text]) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": k === settings.matrix ? "true" : "false",
          class: k === settings.matrix ? "on" : "",
          onclick: () => {
            settings.matrix = k
            buildMatrix()
          }
        },
        text
      )
    )
  )
  const cells = matrixCells()
  matrixStrip.replaceChildren(
    ...cells.map((c) => {
      const host = h("div", { class: "cell-stage" })
      const cost = label("", "cost")
      const conv = new Conversation({ pin: c.pin, user: c.user, agent: c.agent })
      const stage = engine.add(host, design, conv)
      matrixStages.push(stage)
      matrixTickers.push(() => {
        if (tickCount % 15 === 0) cost.textContent = stage.error !== null ? "failed" : fmtCost(stage.cost()).replace(" avg", "")
      })
      return h("figure", { class: "cell" }, host, h("figcaption", {}, label(c.label), cost))
    })
  )
}

// Customise panel ------------------------------------------------------------------------------

const decimalsOf = (x: number): number => String(x).split(".")[1]?.length ?? 0
const fmtValue = (spec: Extract<OptionSpec, { kind: "number" }>, v: number): string => {
  const unit = spec.unit ?? ""
  return `${v.toFixed(decimalsOf(spec.step))}${unit === "" ? "" : /^[a-z]/i.test(unit) ? " " : ""}${unit}`
}
const SWATCH_LABEL: { readonly [K in (typeof PALETTE_KEYS)[number]]: string } = { you: "Your colour", voice: "Assistant colour", ink: "Text colour", inkFaint: "Faint text colour" }
const SWATCH_VAR: { readonly [K in (typeof PALETTE_KEYS)[number]]: string } = { you: "--you", voice: "--voice", ink: "--ink", inkFaint: "--ink-faint" }
const DESIGN_GROUP = "Design"

const customisePanel = (design: Design): HTMLElement => {
  const syncs: Array<() => void> = []
  const set = (id: string, v: unknown) => store.set(design, id, v)

  const control = (spec: OptionSpec): HTMLElement => {
    const dot = h("i", { class: "dot", title: "Changed from the default", hidden: true })
    const valueEl = h("span", { class: "opt-value" })
    const lab = h("span", { class: "opt-label" }, spec.label, dot)
    let widget: HTMLElement
    let head: HTMLElement
    let sync: (v: number | boolean | string) => void
    switch (spec.kind) {
      case "number": {
        const input = h("input", { type: "range", min: String(spec.min), max: String(spec.max), step: String(spec.step), value: String(spec.default), "aria-label": spec.label, oninput: () => set(spec.id, Number(input.value)) }) as HTMLInputElement
        widget = input
        head = h("div", { class: "opt-head" }, lab, valueEl)
        sync = (v) => {
          if (Number(input.value) !== v) input.value = String(v)
          valueEl.textContent = fmtValue(spec, Number(v))
        }
        break
      }
      case "toggle": {
        const sw = h("button", { type: "button", role: "switch", class: "switch", "aria-label": spec.label, "aria-checked": "false", onclick: () => set(spec.id, store.value(design, spec.id) !== true) })
        widget = sw
        head = h("div", { class: "opt-head" }, lab, sw)
        sync = (v) => {
          sw.setAttribute("aria-checked", v === true ? "true" : "false")
          sw.classList.toggle("on", v === true)
        }
        break
      }
      case "choice": {
        const pairs = spec.choices.map((c) => [c.value, c.label] as const)
        head = h("div", { class: "opt-head" }, lab)
        if (pairs.length > 5) {
          const sel = h("select", { "aria-label": spec.label, onchange: () => set(spec.id, sel.value) }, ...pairs.map(([v, t]) => h("option", { value: v }, t))) as HTMLSelectElement
          widget = sel
          sync = (v) => {
            sel.value = String(v)
          }
        } else {
          const buttons = pairs.map(([v, t]) => h("button", { type: "button", role: "radio", "aria-checked": "false", onclick: () => set(spec.id, v) }, t))
          widget = h("div", { class: "seg", role: "radiogroup", "aria-label": spec.label }, ...buttons)
          sync = (v) =>
            buttons.forEach((b, i) => {
              const on = pairs[i]![0] === v
              b.classList.toggle("on", on)
              b.setAttribute("aria-checked", on ? "true" : "false")
            })
        }
        break
      }
      case "color": {
        const swatches = PALETTE_KEYS.map((k) =>
          h("button", { type: "button", class: "swatch", title: SWATCH_LABEL[k], "aria-label": SWATCH_LABEL[k], "aria-pressed": "false", style: `background:var(${SWATCH_VAR[k]})`, onclick: () => set(spec.id, k) })
        )
        const picker = h("input", { type: "color", class: "picker", title: "Pick any colour", "aria-label": `${spec.label}: custom colour`, oninput: () => set(spec.id, picker.value) }) as HTMLInputElement
        widget = h("div", { class: "swatches" }, ...swatches, picker)
        head = h("div", { class: "opt-head" }, lab)
        sync = (v) => {
          PALETTE_KEYS.forEach((k, i) => {
            swatches[i]!.classList.toggle("on", v === k)
            swatches[i]!.setAttribute("aria-pressed", v === k ? "true" : "false")
          })
          const hex = rgbToHex(resolveColor(v, PALETTES[theme()]))
          if (picker.value !== hex) picker.value = hex
          picker.classList.toggle("on", isHexColor(v))
        }
        break
      }
    }
    syncs.push(() => {
      const v = store.value(design, spec.id)
      if (v === undefined) return
      sync(v)
      dot.hidden = isDefault(spec, v)
    })
    return h("div", { class: `opt opt-${spec.kind}` }, head, spec.kind === "toggle" ? null : widget, spec.help !== undefined && h("p", { class: "opt-help" }, spec.help))
  }

  const groups = new Map<string, Array<OptionSpec>>()
  for (const s of store.specs(design)) {
    const g = s.group ?? DESIGN_GROUP
    groups.set(g, [...(groups.get(g) ?? []), s])
  }
  const reset = h("button", { type: "button", class: "reset", title: "Back to this design's defaults", onclick: () => store.reset(design) }, "Reset")
  const json = h("textarea", { class: "json", readonly: true, rows: "3", spellcheck: "false", "aria-label": "Settings as JSON", onfocus: () => json.select() }) as HTMLTextAreaElement
  const copy = h("button", { type: "button", class: "copy" }, "Copy settings") as HTMLButtonElement
  let copied = 0
  copy.addEventListener("click", () => {
    const text = store.json(design)
    const done = () => {
      copy.textContent = "Copied"
      window.clearTimeout(copied)
      copied = window.setTimeout(() => (copy.textContent = "Copy settings"), 1500)
    }
    const fallback = () => {
      json.select()
      try {
        if (document.execCommand("copy")) done()
      } catch {
        // the text box is selected: copy it by hand
      }
    }
    if (navigator.clipboard?.writeText !== undefined) navigator.clipboard.writeText(text).then(done, fallback)
    else fallback()
  })

  const body = h(
    "div",
    { class: "opts" },
    ...[...groups].map(([g, specs]) => h("section", { class: "opt-group" }, h("h3", { class: "label" }, g), ...specs.map(control))),
    h("section", { class: "opt-group share" }, h("h3", { class: "label" }, "Share"), json, h("div", { class: "row" }, copy, h("span", { class: "opt-help" }, "Also kept in this page's link.")))
  )
  const el = h("aside", { class: "customise", "data-shot": "customise", "aria-label": "Customise" }, h("div", { class: "customise-head" }, h("h2", { class: "label section-title" }, "Customise"), reset), body)
  const refresh = () => {
    for (const s of syncs) s()
    reset.disabled = !store.isCustomised(design)
    const text = store.json(design)
    if (json.value !== text) json.value = text
  }
  panelRefresh = refresh
  refresh()
  return el
}

// Options in the URL: `opt.<id>=<value>` in the hash query (and, on first load, the query string).

const optParams = (params: URLSearchParams): { [id: string]: string } => {
  const out: { [id: string]: string } = {}
  for (const [k, v] of params) if (k.startsWith("opt.")) out[k.slice(4)] = v
  return out
}
const hashParams = (): URLSearchParams => {
  const hash = location.hash.replace(/^#/, "")
  const qi = hash.indexOf("?")
  return new URLSearchParams(qi >= 0 ? hash.slice(qi + 1) : "")
}
const withoutOpts = (params: URLSearchParams): URLSearchParams => {
  for (const k of [...params.keys()]) if (k.startsWith("opt.")) params.delete(k)
  return params
}
/** Rewrite the opt.* pairs of the current URL to the design's non-default values (no history entry, no hashchange). */
const syncUrl = () => {
  if (view.kind !== "detail") return
  try {
    const hq = withoutOpts(hashParams())
    for (const [id, v] of store.urlPairs(view.design)) hq.append(`opt.${id}`, v)
    const search = withoutOpts(new URLSearchParams(location.search)).toString()
    const hashQuery = hq.toString().replace(/%24/g, "$")
    history.replaceState(null, "", `${location.pathname}${search !== "" ? `?${search}` : ""}#${encodeURIComponent(view.design.id)}${hashQuery !== "" ? `?${hashQuery}` : ""}`)
  } catch {
    // replaceState can be refused (sandboxed frames); the link just won't mirror the settings
  }
}
let urlTimer = 0
store.onChange((d) => {
  if (view.kind !== "detail" || view.design !== d) return
  panelRefresh?.()
  window.clearTimeout(urlTimer)
  urlTimer = window.setTimeout(syncUrl, 200)
})

// Feature readout --------------------------------------------------------------------------------

interface Meter {
  readonly el: HTMLElement
  update(f: VoiceFeatures): void
}

const meter = (name: string, get: (f: VoiceFeatures) => number, fmt: (f: VoiceFeatures) => string, opts: { centered?: boolean } = {}): Meter => {
  const fill = h("i", {})
  const val = h("span", { class: "val" })
  const el = h("div", { class: "meter" }, h("span", { class: "label" }, name), h("span", { class: `bar${opts.centered === true ? " centered" : ""}` }, fill), val)
  return {
    el,
    update(f) {
      const v = Math.max(opts.centered === true ? -1 : 0, Math.min(1, get(f)))
      if (opts.centered === true) {
        fill.style.left = `${50 + Math.min(0, v) * 50}%`
        fill.style.width = `${Math.abs(v) * 50}%`
      } else fill.style.width = `${v * 100}%`
      val.textContent = fmt(f)
    }
  }
}

const n2 = (x: number) => x.toFixed(2)
const readoutColumn = (who: "user" | "agent") => {
  const meters: Array<Meter> = [
    meter("level", (f) => f.level, (f) => n2(f.level)),
    meter("rms", (f) => Math.sqrt(f.rms * 4), (f) => f.rms.toFixed(3)),
    meter("speaking", (f) => (f.speaking ? 1 : 0), (f) => (f.speaking ? `${f.speechFor.toFixed(1)} s` : `quiet ${f.silenceFor.toFixed(1)} s`)),
    meter("voicing", (f) => f.voicing, (f) => n2(f.voicing)),
    meter("pitch", (f) => f.pitch, (f) => (f.pitchHz > 0 ? `${Math.round(f.pitchHz)} Hz` : `– · ${n2(f.pitch)}`)),
    meter("intonation", (f) => f.pitchDelta / 20, (f) => `${f.pitchDelta >= 0 ? "+" : ""}${f.pitchDelta.toFixed(1)} st/s`, { centered: true }),
    meter("register", (f) => f.register, (f) => n2(f.register)),
    meter("low", (f) => f.low, (f) => n2(f.low)),
    meter("mid", (f) => f.mid, (f) => n2(f.mid)),
    meter("high", (f) => f.high, (f) => n2(f.high)),
    meter("brightness", (f) => f.brightness, (f) => n2(f.brightness)),
    meter("sibilance", (f) => f.sibilance, (f) => n2(f.sibilance)),
    meter("onset", (f) => f.onset, (f) => n2(f.onset)),
    meter("syllables", (f) => f.syllableRate / 8, (f) => `${f.syllableRate.toFixed(1)} /s`),
    meter("mouth open", (f) => f.mouth.open, (f) => n2(f.mouth.open)),
    meter("mouth wide", (f) => f.mouth.wide, (f) => n2(f.mouth.wide)),
    meter("mouth round", (f) => f.mouth.round, (f) => n2(f.mouth.round))
  ]
  const spectrum = h("canvas", { class: "spectrum", width: "240", height: "64", "aria-label": "bands and wave" }) as HTMLCanvasElement
  const head = h("div", { class: "readout-head" }, label(who === "user" ? "You · user" : "Assistant · agent", who === "user" ? "you" : "voice"), label("", "active-tag"))
  const col = h("div", { class: "readout-col" }, head, ...meters.map((m) => m.el), spectrum)
  const g = spectrum.getContext("2d")
  const draw = (f: VoiceFeatures, active: boolean) => {
    col.classList.toggle("active", active)
    head.lastElementChild!.textContent = active ? "active" : ""
    for (const m of meters) m.update(f)
    if (g === null) return
    const p = PALETTES[theme()]
    const W = spectrum.width
    const H = spectrum.height
    g.clearRect(0, 0, W, H)
    const c = who === "user" ? p.you : p.voice
    g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.85)`
    const bw = W / BAND_COUNT
    for (let i = 0; i < BAND_COUNT; i++) {
      const v = f.bands[i]!
      g.fillRect(i * bw + 1, H - v * (H - 2), bw - 2, v * (H - 2))
    }
    g.strokeStyle = `rgba(${p.ink[0]},${p.ink[1]},${p.ink[2]},0.6)`
    g.lineWidth = 1
    g.beginPath()
    const wv = f.wave
    for (let i = 0; i < wv.length; i++) {
      const x = (i / (wv.length - 1)) * W
      const y = H / 2 - Math.max(-1, Math.min(1, wv[i]! * 3)) * (H / 2 - 2)
      if (i === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.stroke()
  }
  return { el: col, draw }
}

const table = (head: readonly [string, string], rows: ReadonlyArray<readonly [string, string]>) =>
  h("table", {}, h("thead", {}, h("tr", {}, h("th", { class: "label" }, head[0]), h("th", { class: "label" }, head[1]))), h("tbody", {}, ...rows.map(([a, b]) => h("tr", {}, h("td", {}, a), h("td", {}, b)))))

const renderDetail = (design: Design) => {
  const stageHost = h("div", { class: "detail-stage", "data-shot": "stage" })
  const modeEl = label("", "mode")
  const costEl = label("– ms", "cost")
  const you = readoutColumn("user")
  const agent = readoutColumn("agent")
  main.replaceChildren(
    h("nav", { class: "crumbs" }, h("a", { href: "#", class: "back" }, "← All designs")),
    h("header", { class: "detail-head" }, h("h1", {}, design.name), label(`${FAMILY_LABEL[design.family]} · ${design.renderer} · ${design.id}.ts`, "faint"), h("p", { class: "summary" }, design.summary)),
    h("div", { class: "detail-top" }, h("div", { class: "stage-wrap" }, stageHost, h("div", { class: "stage-foot" }, modeEl, costEl)), customisePanel(design)),
    h("section", { class: "matrix", "data-shot": "matrix" }, h("div", { class: "matrix-head" }, h("h2", { class: "label section-title" }, "Reaction matrix"), matrixTabs), matrixStrip),
    h("section", { class: "features" }, h("h2", { class: "label section-title" }, "Live features"), h("div", { class: "readout", "aria-label": "Features driving the design" }, you.el, agent.el)),
    h(
      "div",
      { class: "info" },
      h("section", {}, h("h2", { class: "label section-title" }, "Modes"), table(["Mode", "Look"], MODES.map((m) => [MODE_LABEL[m], design.modes[m]] as const))),
      h("section", {}, h("h2", { class: "label section-title" }, "Mappings"), table(["Signal", "Effect"], design.mappings.map((m) => [m.signal, m.effect] as const))),
      h("section", {}, h("h2", { class: "label section-title" }, "Inspired by"), h("p", {}, design.inspiredBy), h("h2", { class: "label section-title" }, "Server needs"), h("p", {}, design.serverNeeds))
    )
  )
  const stage = engine.add(stageHost, design, shared, 10)
  view = { kind: "detail", design, main: stage }
  tickers.push(() => {
    modeEl.textContent = `${MODE_LABEL[shared.mode]}${shared.pinned === "auto" ? " · auto" : " · pinned"}`
    modeEl.dataset.mode = shared.mode
    if (tickCount % 4 === 0) {
      you.draw(shared.user, shared.mode !== "speaking")
      agent.draw(shared.agent, shared.mode === "speaking")
    }
    if (tickCount % 15 === 0) {
      const c = stage.cost()
      costEl.textContent = stage.error !== null ? "failed" : `frame() ${fmtCost(c)}`
      costEl.classList.toggle("over", c !== null && c.mean > 2)
    }
  })
  buildMatrix()
}

let firstRoute = true
const route = () => {
  engine.clear()
  tickers = []
  matrixStages = []
  matrixTickers = []
  const fromHash = location.hash.replace(/^#/, "").split("?")[0] ?? ""
  const id = fromHash !== "" ? decodeURIComponent(fromHash) : initialDesign
  const entry = ENTRIES.find((e) => e.design?.id === id)
  panelRefresh = null
  if (entry?.design !== undefined) {
    // A link with opt.* pairs reproduces its look (the hash wins over the query string and over storage).
    const fromUrl = { ...(firstRoute ? optParams(new URLSearchParams(location.search)) : {}), ...optParams(hashParams()) }
    if (Object.keys(fromUrl).length > 0) store.applyUrl(entry.design, fromUrl)
    renderDetail(entry.design)
    syncUrl()
  } else {
    view = { kind: "gallery" }
    renderGallery()
  }
  firstRoute = false
  renderControls()
}
window.addEventListener("hashchange", () => {
  initialDesign = null
  route()
  window.scrollTo({ top: root.getBoundingClientRect().top + window.scrollY - 8 })
})

root.append(
  h("header", { class: "top" }, h("div", { class: "brand" }, label("Visualiser lab"), label("listening · speaking", "faint")), controls),
  main
)
route()
engine.start()
