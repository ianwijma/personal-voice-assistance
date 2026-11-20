// The system-status module: `system_status`, how the assistant itself is doing, read from the host's own view
// (`ctx.host.view()`: module states, the vault, the speech engines, the known devices) and nothing else. It probes no
// network, reads no disk and runs no command. Stores nothing.
//
// What each device hears (docs/modules/system-status.md): a public device, a device the host does not know and a turn
// with no device hear only whether things are fine. A shared device hears at most three problems by module name and
// state, and how many devices are connected; only a private device hears the devices' names (a phone's name is
// someone's). No error text, reason or detail of a module is ever passed on: they can hold addresses and names.
import { ActionError, CurrentTurn, defineAction, defineModule, Devices, type HostView, makeTool, type Presentation } from "@pva/core"
import { defineTexts, homeLanguage, type Language, say } from "@pva/module-contracts"
import { speakList } from "@pva/language"
import { Effect, Schema } from "effect"
import { cutFor, SCREEN } from "./screen.ts"

export const texts = defineTexts({
  en: {
    fine: "Everything is running.",
    fineCount: "Everything is running: {count} modules.",
    problemHere: "There is a problem. Check the settings page.",
    vaultLocked: "The key vault is locked, so modules that need a key are waiting for you to unlock it in Settings.",
    engineState: "The speech engines are {state}.",
    engineStarting: "starting",
    engineReloading: "reloading",
    engineFailed: "stopped with an error",
    moduleError: "{name} has stopped with an error.",
    moduleUnavailable: "{name} is unavailable.",
    moreProblems: "And {count} more.",
    devicesNone: "No device is connected.",
    devicesSome: "Connected devices: {names}.",
    devicesCount: "{count} devices are connected.",
    modulesRunning: "{count} modules are running.",
    modulesOff: "{count} are switched off.",
    issuesTitle: "Problems as just answered",
    itemVault: "The key vault is locked."
  },
  nl: {
    fine: "Alles werkt.",
    fineCount: "Alles werkt: {count} modules.",
    problemHere: "Er is een probleem. Kijk op de instellingenpagina.",
    vaultLocked: "De sleutelkluis is op slot, dus modules die een sleutel nodig hebben wachten tot je hem ontgrendelt in de instellingen.",
    engineState: "De spraakmotoren zijn {state}.",
    engineStarting: "aan het opstarten",
    engineReloading: "aan het herladen",
    engineFailed: "gestopt met een fout",
    moduleError: "{name} is gestopt met een fout.",
    moduleUnavailable: "{name} is niet beschikbaar.",
    moreProblems: "En nog {count}.",
    devicesNone: "Er is geen apparaat verbonden.",
    devicesSome: "Verbonden apparaten: {names}.",
    devicesCount: "{count} apparaten zijn verbonden.",
    modulesRunning: "{count} modules draaien.",
    modulesOff: "{count} staan uit.",
    issuesTitle: "Problemen zoals net gemeld",
    itemVault: "De sleutelkluis is op slot."
  }
})

const MAX_PROBLEMS = 3
const PERSON_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const one = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 80)

/** What is wrong, from the host's view, worst first: kinds, states and module names only, never a reason or error text. */
export const problemsOf = (view: HostView) => {
  const list: Array<{ readonly kind: "vault" | "engine" | "module"; readonly state?: string; readonly name?: string }> = []
  if (view.vaultLocked === true) list.push({ kind: "vault" })
  if (view.engine !== undefined && !view.engine.ready) list.push({ kind: "engine", state: view.engine.state })
  for (const m of view.modules) if (m.state === "error") list.push({ kind: "module", state: "error", name: one(m.name) })
  for (const m of view.modules) if (m.state === "unavailable") list.push({ kind: "module", state: "unavailable", name: one(m.name) })
  return list
}

const engineWords = (state: string | undefined, lang: Language): string =>
  say(texts, lang, state === "starting" ? "engineStarting" : state === "reloading" ? "engineReloading" : "engineFailed")

type About = "all" | "modules" | "devices"

/** How much the asking device may hear: `none` (public, unknown, no device), `shared`, or `private`. */
type Detail = "none" | "shared" | "private"

const report = (view: HostView, lang: Language, about: About, detail: Detail) => {
  const problems = problemsOf(view)
  const running = view.modules.filter((m) => m.state === "running").length
  const off = view.modules.filter((m) => m.state === "disabled").length
  const connected = view.devices.filter((d) => d.connections > 0)
  // A public screen, or a device the host does not know, hears whether things are fine and nothing of what is wrong.
  if (detail === "none") {
    const spoken = problems.length === 0 ? say(texts, lang, "fine") : say(texts, lang, "problemHere")
    return { spoken, fine: problems.length === 0 }
  }
  const lines: Array<string> = []
  const shown = problems.slice(0, MAX_PROBLEMS)
  if (about !== "devices") {
    if (problems.length === 0) lines.push(about === "modules" ? say(texts, lang, "modulesRunning", { count: running }) : say(texts, lang, "fineCount", { count: running }))
    for (const p of shown) {
      lines.push(
        p.kind === "vault" ? say(texts, lang, "vaultLocked")
          : p.kind === "engine" ? say(texts, lang, "engineState", { state: engineWords(p.state, lang) })
          : say(texts, lang, p.state === "error" ? "moduleError" : "moduleUnavailable", { name: p.name ?? "" })
      )
    }
    if (problems.length > shown.length) lines.push(say(texts, lang, "moreProblems", { count: problems.length - shown.length }))
    if (about === "modules" && off > 0) lines.push(say(texts, lang, "modulesOff", { count: off }))
  }
  if (about !== "modules") {
    const names = connected.slice(0, 5).map((d) => one(d.name))
    lines.push(
      connected.length === 0 ? say(texts, lang, "devicesNone")
        : detail === "private" && connected.length <= 5 ? say(texts, lang, "devicesSome", { names: speakList(names, lang) ?? names.join(", ") })
        : say(texts, lang, "devicesCount", { count: connected.length })
    )
  }
  return {
    spoken: lines.join(" "),
    fine: problems.length === 0,
    problems: shown.map((p) => ({ ...p })),
    running,
    connectedDevices: connected.length
  }
}

const problemLine = (p: ReturnType<typeof problemsOf>[number], lang: Language): string =>
  p.kind === "vault" ? say(texts, lang, "vaultLocked")
    : p.kind === "engine" ? say(texts, lang, "engineState", { state: engineWords(p.state, lang) })
    : say(texts, lang, p.state === "error" ? "moduleError" : "moduleUnavailable", { name: p.name ?? "" })

/**
 * One problem as a line of the list: the answer's own sentence, except that the vault's (a long one) is its short form,
 * and a module's name is cut to fit the line, so no sentence is ever cut in the middle.
 */
const itemLine = (p: ReturnType<typeof problemsOf>[number], lang: Language): string => {
  if (p.kind === "vault") return say(texts, lang, "itemVault")
  if (p.kind === "module") {
    const room = SCREEN.listItem - problemLine({ ...p, name: "" }, lang).length
    return problemLine({ ...p, name: cutFor(p.name ?? "", Math.max(room, 8)) }, lang)
  }
  return problemLine(p, lang)
}

/**
 * The issues the tool reports, as a list for a screen, or `undefined` when there is nothing to show: it shows exactly
 * what the answer said to this device and nothing more (docs/modules/system-status.md). A device that is told only
 * whether things are fine (public, unknown, no device), an answer about devices only and a house with no problem have
 * no list. At most three problems, as the answer names them, then "And N more." when the count is more.
 */
export const issuesList = (view: HostView, lang: Language, about: About, detail: Detail, person: string | undefined): Presentation | undefined => {
  // Only for a known asker, as theirs: the Presenter decides it again for each device at each moment.
  if (detail === "none" || about === "devices" || person === undefined || !PERSON_ID.test(person)) return undefined
  const problems = problemsOf(view)
  if (problems.length === 0) return undefined
  const shown = problems.slice(0, MAX_PROBLEMS)
  const items = shown.map((p, i) => ({ id: `p${i}`, text: itemLine(p, lang) }))
  if (problems.length > shown.length) items.push({ id: "more", text: cutFor(say(texts, lang, "moreProblems", { count: problems.length - shown.length }), SCREEN.listItem) })
  return {
    kind: "list",
    title: cutFor(say(texts, lang, "issuesTitle"), SCREEN.title),
    style: "bullets",
    items,
    sensitivity: { personal: person },
    // What is said where nothing shows it: the answer's own words about the problems (one sentence per problem).
    spoken: cutFor(items.map((i) => i.text).join(" "), SCREEN.spoken)
  }
}

export const systemStatusModule = defineModule({
  apiVersion: 2,
  id: "system-status",
  name: "System status",
  description: "How the assistant itself is doing: its modules, engines and devices.",
  enabledByDefault: false,
  start: (ctx) =>
    Effect.sync(() => {
      /** How much the asking device may hear, looked up now: public, unknown and no device hear only whether it is fine. */
      const mayDetail = Effect.gen(function*() {
        const turn = yield* CurrentTurn
        const device = turn?.deviceId === undefined ? undefined : ctx.host.service(Devices)?.get(turn.deviceId)
        const privacy = device?.place.privacy
        return (privacy === "private" ? "private" : privacy === "shared" ? "shared" : "none") as Detail
      })
      /** The answer, and the list that goes with it (a snapshot of this answer; shown by the Presenter once the turn is committed). */
      const answer = (about: About, detail: Detail) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const view = ctx.host.view()
          const lang = homeLanguage(view)
          return { result: report(view, lang, about, detail), list: issuesList(view, lang, about, detail, turn?.person?.id) }
        })
      const tool = makeTool({
        name: "system_status",
        description:
          "How the assistant itself is doing: whether its modules, speech engines and key vault are fine, and which devices are connected. Use it for \"how is the server doing\" or \"is everything working\". " +
          "Reads only what the assistant already knows; on a public screen it says only whether things are fine. Say what it found; do not guess at causes.",
        parameters: Schema.Struct({
          about: Schema.optionalKey(Schema.Literals(["all", "modules", "devices"]).annotate({ description: "What to report on (default all)" }))
        }),
        speculative: true,
        latency: "instant",
        execute: ({ about }) =>
          Effect.gen(function*() {
            const detail = yield* mayDetail
            const { result, list } = yield* answer(about ?? "all", detail)
            return list === undefined ? result : { forModel: result, present: list }
          })
      })
      const action = defineAction({
        id: "status",
        label: "How is the assistant doing",
        description: "Say whether the assistant's modules, speech engines and devices are fine.",
        examples: ["how is the server doing", "is everything working", "hoe gaat het met de server", "werkt alles"],
        params: {},
        speculative: true,
        offerAsTool: false,
        run: () =>
          Effect.gen(function*() {
            const detail = yield* mayDetail
            const { result, list } = yield* answer("all", detail)
            return list === undefined ? { say: result.spoken } : { say: result.spoken, present: list }
          }).pipe(Effect.mapError(() => new ActionError({ message: "" })))
      })
      return { tools: [tool], actions: [action], instructions: "For \"how is the server doing\" or \"is everything working\", use system_status." }
    })
})
