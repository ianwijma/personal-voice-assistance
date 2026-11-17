/**
 * The voice connection's side of protocol 7 in the mock (docs/ASSISTANTS.md §5.3): the device's setup (`device.setup`,
 * `snapshot.setup`), one conversation per assistant, who has the turn, `device.pick`, `conversation.read`. It reads the
 * assistants and the devices' settings from `assistants.ts` (what admin saved), so a pick on the voice page is visible
 * in the admin state. `server.ts` sends the messages and runs the turns; this module holds the rules and the data.
 */
import type { ConversationInfo, DeviceSetup, DeviceSettings, DeviceSettingsPatch, HistoryItem } from "@pva/protocol"
import { deviceSetupFrom, WEB_VOICE_KIND } from "@pva/protocol"
import type { AssistantResult, AssistantsMock } from "./assistants.ts"

/** One conversation of one assistant on one device (the fields `VSession` also has for its first conversation). */
export interface Conv {
  history: Array<HistoryItem>
  conversation: ConversationInfo
  turns: number
  lastTurnAt: number | null
}

/** What `VSession` has of its first conversation; the mock keeps that one where it always was. */
export interface SessionRef extends Conv {
  readonly key: string
}

/** The admin mock-up's sample exchanges, for the conversations the page has not talked in yet. */
const SAMPLES: Readonly<Record<string, ReadonlyArray<readonly [string, string, string]>>> = {
  jeff: [
    ["Is the back door locked?", "read_state", "Yes, the back door is locked. The garden light is still on."],
    ["Turn it off.", "turn_off", "Done, the garden light is off."]
  ],
  t3: [
    ["How is the voice sessions thread doing?", "read_thread", "It finished twelve minutes ago. The tests pass and it is waiting for your review."],
    ["Tell it to merge when the checks are green.", "send_message", "Sent. It will merge once the checks are green."]
  ],
  keuken: [
    ["Zet eieren op het boodschappenlijstje.", "add_item", "Eieren staan op je boodschappenlijst."],
    ["Hoe lang moet een zachtgekookt ei?", "", "Zes minuten in kokend water, daarna even koud afspoelen."]
  ]
}

const sampleHistory = (id: string): Array<HistoryItem> =>
  (SAMPLES[id] ?? []).flatMap(([you, tool, reply]) => [
    { role: "user", text: you } satisfies HistoryItem,
    { role: "assistant", text: reply, interrupted: false, tools: tool === "" ? [] : [{ name: tool, ok: true }] } satisfies HistoryItem
  ])

/** What the scripted voice turn says for an assistant: Jeff's is the weather turn the mock always had. */
export interface ScriptedTurn {
  readonly userText: string
  readonly clauses: ReadonlyArray<string>
  readonly tool: { readonly name: string; readonly moduleId: string; readonly input: unknown; readonly ms: number }
}
const SCRIPTS: Readonly<Record<string, ScriptedTurn>> = {
  t3: {
    userText: "Start a thread to add the assistant menu",
    clauses: ["Started a thread for the assistant menu", "in personal-voice-assistance.", "It is reading the voice page now,", "and I'll tell you when it needs you."],
    tool: { name: "start_thread", moduleId: "t3-code", input: { title: "Assistant menu" }, ms: 180 }
  },
  keuken: {
    userText: "Zet een timer op tien minuten",
    clauses: ["Goed, een timer van tien minuten", "voor de eieren.", "Ik zeg het als hij afloopt."],
    tool: { name: "start_timer", moduleId: "timers", input: { minutes: 10 }, ms: 90 }
  }
}
export const scriptedTurn = (assistantId: string | undefined, fallback: ScriptedTurn): ScriptedTurn => (assistantId === undefined ? undefined : SCRIPTS[assistantId]) ?? fallback

const norm = (phrase: string) => phrase.trim().toLowerCase().replace(/\s+/g, " ")

export interface VoiceAssistants {
  readonly reset: () => void
  /** Is the decision service ("Whichever fits") set up? Off by default. */
  readonly setCanAuto: (on: boolean) => void
  /** The setup of a device (`deviceId` absent: a page without one, which follows the type's defaults). */
  readonly setupFor: (deviceId: string | undefined) => DeviceSetup
  readonly settingsOf: (deviceId: string | undefined) => DeviceSettings
  /** The assistant that has the turn, else who answers without a phrase (Auto: its fallback), else the first. */
  readonly answeringOf: (v: object, deviceId: string | undefined) => string | undefined
  readonly holderOf: (v: object) => string | undefined
  readonly setHolder: (v: object, id: string | undefined) => void
  /** Whether the device sleeps until a phrase (nobody answers without one). */
  readonly sleeps: (deviceId: string | undefined) => boolean
  /** The assistant a phrase belongs to on this device. */
  readonly phraseOwner: (deviceId: string | undefined, phrase: string) => string | undefined
  /** How long this assistant keeps listening after a reply on this device (assignment, else the assistant). */
  readonly followUpMs: (deviceId: string | undefined, assistantId: string | undefined) => number
  /** One assistant's conversation on a session. The session's own fields hold the first one it was asked about. */
  readonly convFor: (v: SessionRef, assistantId: string | undefined) => Conv
  /** The snapshot's list: one per assistant of the setup. */
  readonly conversationsOf: (v: SessionRef | undefined, setup: DeviceSetup) => Array<{ assistantId: string; id: string; startedAt: number; turns: number }>
  /** `device.pick`: write the device's own `withoutPhrase`. */
  readonly pick: (deviceId: string, value: string) => AssistantResult
  /** A test's change of a device's (or the type's) settings, as admin would save it. */
  readonly saveSettings: (deviceId: string | undefined, settings: DeviceSettingsPatch) => AssistantResult
}

export const createVoiceAssistants = (assistants: AssistantsMock, newConversationInfo: () => ConversationInfo): VoiceAssistants => {
  let canAuto = false
  /** Conversations other than the session's first, by session then assistant. */
  let extra = new WeakMap<object, Map<string, Conv>>()
  let first = new WeakMap<object, string>()
  let holders = new WeakMap<object, string | undefined>()

  /** The device's effective settings (without a device: the web-voice type's). */
  const settingsOf = (deviceId: string | undefined) => assistants.deviceFields(deviceId ?? "").settings
  const known = new Map<string, { id: string; name: string; purpose: string; on: boolean }>()
  const setupFor = (deviceId: string | undefined): DeviceSetup => {
    known.clear()
    for (const a of assistants.assistants()) known.set(a.id, a)
    return deviceSetupFrom(settingsOf(deviceId), known, { ...(deviceId !== undefined ? { deviceId } : {}), canAuto })
  }
  const holderOf = (v: object) => holders.get(v)
  const answeringOf = (v: object, deviceId: string | undefined): string | undefined => {
    const setup = setupFor(deviceId)
    const ids = setup.assistants.map((a) => a.id)
    const held = holders.get(v)
    if (held !== undefined && ids.includes(held)) return held
    const wp = setup.withoutPhrase
    if (wp.mode === "assistant" && ids.includes(wp.assistant)) return wp.assistant
    if (wp.mode === "typesafe" && wp.fallback !== null && ids.includes(wp.fallback)) return wp.fallback
    return ids[0]
  }

  const fresh = (id: string): Conv => {
    const now = Date.now()
    const history = sampleHistory(id)
    return {
      history,
      conversation: { id: `conv-${id}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, startedAt: now - 6 * 60_000 },
      turns: history.filter((h) => h.role === "user").length,
      lastTurnAt: now - 5 * 60_000
    }
  }
  const convFor = (v: SessionRef, assistantId: string | undefined): Conv => {
    const id = assistantId ?? ""
    const firstId = first.get(v) ?? (first.set(v, id), id)
    if (id === firstId) return v // the session's own fields: the first conversation, with the example history
    let map = extra.get(v)
    if (map === undefined) extra.set(v, (map = new Map()))
    let conv = map.get(id)
    if (conv === undefined) map.set(id, (conv = id === "" ? { history: [], conversation: newConversationInfo(), turns: 0, lastTurnAt: null } : fresh(id)))
    return conv
  }

  const mock: VoiceAssistants = {
    reset: () => {
      extra = new WeakMap()
      first = new WeakMap()
      holders = new WeakMap()
      canAuto = false
    },
    setCanAuto: (on) => {
      canAuto = on
    },
    setupFor,
    settingsOf,
    answeringOf,
    holderOf,
    setHolder: (v, id) => {
      holders.set(v, id)
    },
    sleeps: (deviceId) => settingsOf(deviceId).withoutPhrase.mode === "nobody",
    phraseOwner: (deviceId, phrase) => settingsOf(deviceId).assistants.find((a) => a.phrases.some((p) => norm(p) === norm(phrase)))?.assistant,
    followUpMs: (deviceId, assistantId) => {
      const assignment = settingsOf(deviceId).assistants.find((a) => a.assistant === assistantId)
      const assistant = assistants.assistants().find((a) => a.id === assistantId)
      return (assignment?.followUpSeconds ?? assistant?.followUpSeconds ?? 0) * 1000
    },
    convFor,
    conversationsOf: (v, setup) =>
      setup.assistants.map((a) => {
        const c = v === undefined ? { conversation: newConversationInfo(), turns: 0 } : convFor(v, a.id)
        return { assistantId: a.id, id: c.conversation.id, startedAt: c.conversation.startedAt, turns: c.turns }
      }),
    pick: (deviceId, value) => {
      const setup = setupFor(deviceId)
      if (!setup.canPick) return { ok: false, error: { code: "not_allowed", message: "This device does not let people pick the assistant." } }
      if (value === "typesafe" && !setup.canAuto) return { ok: false, error: { code: "not_allowed", message: "Whichever fits is not set up." } }
      if (value !== "" && value !== "typesafe" && !setup.assistants.some((a) => a.id === value)) {
        return { ok: false, error: { code: "unknown_assistant", message: `${value} is not one of the assistants on this device.` } }
      }
      const current = settingsOf(deviceId).withoutPhrase
      const withoutPhrase: DeviceSettings["withoutPhrase"] =
        value === ""
          ? { mode: "nobody" }
          : value === "typesafe"
          ? { mode: "typesafe", fallback: current.mode === "typesafe" ? current.fallback : null, giveUpMs: current.mode === "typesafe" ? current.giveUpMs : 400 }
          : { mode: "assistant", assistant: value }
      return assistants.saveDevice({ target: { kind: "device", id: deviceId }, rev: assistants.deviceFields(deviceId).rev, settings: { withoutPhrase }, saveAnyway: true })
    },
    saveSettings: (deviceId, settings) => {
      if (deviceId === undefined) {
        const rev = assistants.deviceTypes()[0]?.rev ?? 0
        return assistants.saveDevice({ target: { kind: "type", type: WEB_VOICE_KIND }, rev, settings, saveAnyway: true })
      }
      return assistants.saveDevice({ target: { kind: "device", id: deviceId }, rev: assistants.deviceFields(deviceId).rev, settings, saveAnyway: true })
    }
  }
  return mock
}

/**
 * What the `wake` and `long-phrase` scenarios say about the web-voice type: the device sleeps until the phrase, and
 * Jeff is the one it wakes. Saved as admin would save it.
 */
export const scenarioSettings = (scenario: string, longPhrase: string): DeviceSettingsPatch | undefined =>
  scenario === "wake"
    ? { assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }], withoutPhrase: { mode: "nobody" } }
    : scenario === "long-phrase"
    ? { assistants: [{ assistant: "jeff", phrases: [longPhrase] }], withoutPhrase: { mode: "nobody" } }
    : undefined
