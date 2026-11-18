// The system-status module: `system_status`, how the assistant itself is doing, read from the host's own view
// (`ctx.host.view()`: module states, the vault, the speech engines, the known devices) and nothing else. It probes no
// network, reads no disk and runs no command. Stores nothing.
import { ActionError, CurrentTurn, defineAction, defineModule, Devices, type HostView, makeTool } from "@pva/core"
import { defineTexts, homeLanguage, type Language, say } from "@pva/module-contracts"
import { speakList } from "@pva/language"
import { Effect, Schema } from "effect"

export const texts = defineTexts({
  en: {
    fine: "Everything is running.",
    fineCount: "Everything is running: {count} modules.",
    problemHere: "There is a problem. Check the settings page.",
    vaultLocked: "The key vault is locked, so modules that need a key are waiting for you to unlock it in Settings.",
    engineState: "The speech engines are {state}.",
    moduleError: "{name} has stopped with an error.",
    moduleUnavailable: "{name} is unavailable.",
    moreProblems: "And {count} more.",
    devicesNone: "No device is connected.",
    devicesSome: "Connected devices: {names}.",
    devicesCount: "{count} devices are connected.",
    modulesRunning: "{count} modules are running.",
    modulesOff: "{count} are switched off."
  },
  nl: {
    fine: "Alles werkt.",
    fineCount: "Alles werkt: {count} modules.",
    problemHere: "Er is een probleem. Kijk op de instellingenpagina.",
    vaultLocked: "De sleutelkluis is op slot, dus modules die een sleutel nodig hebben wachten tot je hem ontgrendelt in de instellingen.",
    engineState: "De spraakmotoren zijn {state}.",
    moduleError: "{name} is gestopt met een fout.",
    moduleUnavailable: "{name} is niet beschikbaar.",
    moreProblems: "En nog {count}.",
    devicesNone: "Er is geen apparaat verbonden.",
    devicesSome: "Verbonden apparaten: {names}.",
    devicesCount: "{count} apparaten zijn verbonden.",
    modulesRunning: "{count} modules draaien.",
    modulesOff: "{count} staan uit."
  }
})

const MAX_PROBLEMS = 3
const one = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 80)

/** What is wrong, from the host's view, worst first. */
export const problemsOf = (view: HostView) => {
  const list: Array<{ readonly kind: "vault" | "engine" | "module"; readonly state?: string; readonly name?: string; readonly reason?: string }> = []
  if (view.vaultLocked === true) list.push({ kind: "vault" })
  if (view.engine !== undefined && !view.engine.ready) list.push({ kind: "engine", state: view.engine.state })
  for (const m of view.modules) {
    if (m.state === "error") list.push({ kind: "module", state: "error", name: m.name, ...(m.unavailable !== undefined ? { reason: one(m.unavailable) } : {}) })
  }
  for (const m of view.modules) {
    if (m.state === "unavailable") list.push({ kind: "module", state: "unavailable", name: m.name, ...(m.unavailable !== undefined ? { reason: one(m.unavailable) } : {}) })
  }
  return list
}

type About = "all" | "modules" | "devices"

const report = (view: HostView, lang: Language, about: About, detail: boolean) => {
  const problems = problemsOf(view)
  const running = view.modules.filter((m) => m.state === "running").length
  const off = view.modules.filter((m) => m.state === "disabled").length
  const connected = view.devices.filter((d) => d.connections > 0)
  // A public screen, or a device the host does not know, hears whether things are fine and nothing of what is wrong.
  if (!detail) {
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
          : p.kind === "engine" ? say(texts, lang, "engineState", { state: p.state ?? "" })
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
        : connected.length <= 5 ? say(texts, lang, "devicesSome", { names: speakList(names, lang) ?? names.join(", ") })
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

export const systemStatusModule = defineModule({
  apiVersion: 2,
  id: "system-status",
  name: "System status",
  description: "How the assistant itself is doing: its modules, engines and devices.",
  enabledByDefault: false,
  start: (ctx) =>
    Effect.sync(() => {
      /** Whether the asking device may hear what is wrong: a shared or private one. Public, unknown and no device: only whether it is fine. */
      const mayDetail = Effect.gen(function*() {
        const turn = yield* CurrentTurn
        const device = turn?.deviceId === undefined ? undefined : ctx.host.service(Devices)?.get(turn.deviceId)
        return device !== undefined && device.place.privacy !== "public"
      })
      const tool = makeTool({
        name: "system_status",
        description:
          "How the assistant itself is doing: whether its modules, speech engines and key vault are fine, and which devices are connected. Use it for \"how is the server doing\" or \"is everything working\". " +
          "Reads only what the assistant already knows; on a public screen it says only whether things are fine.",
        parameters: Schema.Struct({
          about: Schema.optionalKey(Schema.Literals(["all", "modules", "devices"]).annotate({ description: "What to report on (default all)" }))
        }),
        speculative: true,
        latency: "instant",
        execute: ({ about }) =>
          Effect.gen(function*() {
            const detail = yield* mayDetail
            return report(ctx.host.view(), homeLanguage(ctx.host.view()), about ?? "all", detail)
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
            const view = ctx.host.view()
            return { say: report(view, homeLanguage(view), "all", detail).spoken }
          }).pipe(Effect.mapError(() => new ActionError({ message: "" })))
      })
      return { tools: [tool], actions: [action], instructions: "For \"how is the server doing\" or \"is everything working\", use system_status." }
    })
})
