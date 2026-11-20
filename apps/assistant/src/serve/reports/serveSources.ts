import { type DevicesService, hasScreen, type KnownDevice, type PresentView, voiceKey } from "@pva/core"
import { type Assistant, PROTOCOL_VERSION } from "@pva/protocol"
import { Effect } from "effect"
import type { VoiceSessions } from "../VoiceSessions.ts"
import type { ReportSources } from "./context.ts"
import type { PreviousConversations } from "./previous.ts"
import type { Fact, HealthLine, LogLine } from "./render.ts"

/**
 * Serve mode's sources of a report (`context.ts`): the voice sessions (late-bound), the previous conversations, the
 * device registry and the Presenter, the assistants in effect, the Health issues and the server's facts. Metadata only:
 * no key, no token, no person's name (a device's default person is said to be set, not who it is).
 */
export interface ServeReportSourcesOptions {
  readonly sessions: () => VoiceSessions | undefined
  readonly previous: PreviousConversations
  readonly devices: DevicesService
  readonly present: { readonly live: () => ReadonlyArray<PresentView>; readonly held: (deviceId: string) => ReadonlyArray<{ readonly ids: ReadonlyArray<string> }> }
  readonly assistants: () => ReadonlyMap<string, Assistant>
  readonly homeLanguage: () => unknown
  readonly issues: () => ReadonlyArray<{ readonly id: string; readonly severity: string; readonly title: string; readonly detail?: string | undefined }>
  readonly modulesRunning: () => ReadonlyArray<string>
  readonly warnings: () => ReadonlyArray<LogLine>
  readonly version: string
  readonly startedAt: number
}

/** A device's privacy boundary, as the previous conversations compare it (`previous.ts`). */
export const boundaryOf = (d: KnownDevice | undefined): string | undefined => (d === undefined ? undefined : JSON.stringify([d.place.privacy, d.place.defaultPerson]))

const iso = (ms: number | undefined) => (ms === undefined || !Number.isFinite(ms) ? "unknown" : new Date(ms).toISOString())
const yesNo = (b: boolean | undefined) => (b === true ? "yes" : "no")

const deviceFacts = (d: KnownDevice): ReadonlyArray<Fact> => {
  const c = d.capabilities
  const display = c.display
  return [
    ["Name", d.name],
    ["Id", d.id],
    ["Kind", d.kind],
    ["Room", d.room ?? "(none)"],
    ["Privacy", d.place.privacy],
    ["Default person", d.place.defaultPerson === null ? "none" : "set"],
    ["Always on", yesNo(d.place.alwaysOn)],
    ["Accepts from other devices", yesNo(d.place.acceptsFromOthers)],
    ["Quiet room", yesNo(d.place.quietRoom)],
    ["Connected now", yesNo(d.connected)],
    ["A tab visible now", yesNo(d.visible)],
    ["Has a screen", hasScreen(d) ? "yes" : "no"],
    ...(display !== undefined
      ? [["Screen", `${display.class}, ${display.widthPx}×${display.heightPx} px at ${display.dpr}x, touch ${display.touch}${display.colour ? "" : ", no colour"}`] as Fact]
      : []),
    ["Presentation kinds", c.present === undefined ? "none" : Object.entries(c.present.kinds).map(([k, v]) => `${k} v${v}`).join(", ")],
    ["Speaker", c.speaker === undefined ? "none" : c.speaker.media.join(", ")],
    ["Microphone", c.microphone === undefined ? "none" : c.microphone.farField ? "far-field" : "near"],
    ["Opens links", yesNo(c.openUrl)],
    ["Declared", d.declared === undefined ? "never" : "yes"],
    ["Last seen", iso(d.lastSeen)],
    ["Last interaction", iso(d.lastInteractionAt)]
  ]
}

const assistantFacts = (a: Assistant, homeLanguage: unknown): ReadonlyArray<Fact> => [
  ["Name", a.name],
  ["Id", a.id],
  ["On", yesNo(a.on)],
  ["Household language", typeof homeLanguage === "string" && homeLanguage !== "" ? homeLanguage : "(default)"],
  ["Language model", `${a.llm.account} ${a.llm.model} (effort ${a.llm.effort}, thinking ${a.llm.thinking}, max tokens ${a.llm.maxTokens}, gives up after ${a.llm.giveUpMs} ms)`],
  ["Hearing", `${a.hearing.engine}${a.hearing.model !== "" ? ` ${a.hearing.model}` : ""}, language ${a.hearing.language}, silences ${a.hearing.eagerSilenceMs}/${a.hearing.finalSilenceMs} ms`],
  ["Voice", voiceKey(a.voice)],
  ["Modules on", Object.entries(a.modules).filter(([, c]) => c.on).map(([id, c]) => (c.offTools.length > 0 ? `${id} (off: ${c.offTools.join(", ")})` : id)).join(", ") || "none"],
  ["Tool rounds", String(a.toolRounds)],
  ["New conversation after", a.newConversationAfter === "never" ? "never" : `${a.newConversationAfter} min quiet`],
  ["Follow-up window", `${a.followUpSeconds} s`],
  ["Reply early", yesNo(a.replyEarly)]
]

export const makeServeReportSources = (o: ServeReportSourcesOptions): ReportSources => ({
  conversation: (deviceId, assistantId) =>
    Effect.suspend(() => {
      const session = o.sessions()?.get(deviceId)
      if (session === undefined) return Effect.succeed(undefined)
      const info = session.conversation.conversation(assistantId)
      return Effect.map(session.conversation.history(assistantId), (history) => ({ conversationId: info.id, history }))
    }),
  previous: (deviceId, assistantId) => o.previous.get(deviceId, assistantId, boundaryOf(o.devices.get(deviceId))),
  traces: () => o.sessions()?.traces() ?? [],
  device: (deviceId) => {
    const d = o.devices.get(deviceId)
    if (d === undefined) return undefined
    const held = new Set(o.present.held(deviceId).flatMap((c) => c.ids))
    const shown = o.present.live().filter((p) => held.has(p.id)).map((p) => ({ kind: p.kind, module: p.module, lifetime: p.lifetime, shownAt: p.shownAt }))
    return { name: d.name, facts: deviceFacts(d), shown }
  },
  assistant: (assistantId) => {
    const a = o.assistants().get(assistantId)
    return a === undefined ? undefined : { name: a.name, facts: assistantFacts(a, o.homeLanguage()) }
  },
  server: () => [
    ["Version", o.version],
    ["Commit", "not known (no build carries one yet)"],
    ["Protocol", String(PROTOCOL_VERSION)],
    ["Node", process.version],
    ["Platform", `${process.platform} ${process.arch}`],
    ["Started", iso(o.startedAt)],
    ["Modules running", o.modulesRunning().join(", ") || "none"]
  ],
  health: (): ReadonlyArray<HealthLine> => o.issues().map((i) => ({ severity: i.severity, id: i.id, title: i.title, ...(i.detail !== undefined ? { detail: i.detail } : {}) })),
  warnings: o.warnings
})
