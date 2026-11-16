import type { ConversationInfo, DeviceProfile, DeviceSetup, HistoryItem, ServerMessage, Snapshot } from "@pva/protocol"
import { DEFAULT_DEVICE_PROFILE } from "@pva/protocol"
import type { ClientState, TurnView } from "./state.ts"

/**
 * The voice page's view of its device (docs/ASSISTANTS.md §5.3, §7.2): which assistants answer here, who answers
 * without a phrase, who has the turn now, and one conversation per assistant. Pure functions over `ClientState`; the
 * reducer in `state.ts` calls the `on…` handlers, the components read the selectors. Only types come from `state.ts`,
 * so the two modules do not import each other at run time.
 */

export type SetupAssistant = DeviceSetup["assistants"][number]

/** What the page knows of one assistant's conversation on this device. */
export interface ConversationView {
  readonly id: string
  readonly startedAt: number
  /** Exchanges the server counted when it last said (the snapshot); the page's own turns count once `loaded`. */
  readonly turns: number
  /** The page holds the whole history of this conversation (the snapshot's, a `conversation.history`, a reset). */
  readonly loaded: boolean
  /** The chat starts with a divider: a new conversation began while this page was open. */
  readonly divider?: "new" | "idle"
}

export const NO_ASSISTANT = "No assistant on this device"

// ---- Who answers

const idsOf = (setup: DeviceSetup | undefined): ReadonlyArray<string> => setup?.assistants.map((a) => a.id) ?? []

/** The assistant that answers without a phrase, if one is named (not Auto, not nobody). */
export const defaultAssistantId = (setup: DeviceSetup | undefined): string | undefined =>
  setup !== undefined && setup.withoutPhrase.mode === "assistant" && idsOf(setup).includes(setup.withoutPhrase.assistant)
    ? setup.withoutPhrase.assistant
    : undefined

/** The assistant that has the turn now (a phrase woke it, or it answered last and keeps listening), if still on the device. */
export const holderOf = (s: ClientState): string | undefined => (s.holder !== undefined && idsOf(s.setup).includes(s.holder) ? s.holder : undefined)

/**
 * The assistant the chat talks to by default: the one with the turn, else the one that answers without a phrase (with
 * Auto: its fallback), else the first (it hears for the device).
 */
export const answeringId = (s: ClientState): string | undefined => {
  const ids = idsOf(s.setup)
  if (ids.length === 0) return undefined
  const held = holderOf(s)
  if (held !== undefined) return held
  const wp = s.setup!.withoutPhrase
  if (wp.mode === "assistant" && ids.includes(wp.assistant)) return wp.assistant
  if (wp.mode === "typesafe" && wp.fallback !== null && ids.includes(wp.fallback)) return wp.fallback
  return ids[0]
}

/** The conversation the chat shows: the one picked in its header, else the answering assistant's. Reading changes nobody's turn. */
export const viewedId = (s: ClientState): string | undefined => {
  const picked = s.ui.chatView
  return picked !== undefined && idsOf(s.setup).includes(picked) ? picked : answeringId(s)
}

export const assistantOf = (s: ClientState, id: string | undefined): SetupAssistant | undefined => s.setup?.assistants.find((a) => a.id === id)
/** The name to show; before the setup arrives (or for an assistant that left the device) the plain word. */
export const nameOf = (s: ClientState, id: string | undefined): string => assistantOf(s, id)?.name ?? "Assistant"

/** The assistant that owns a message's `assistantId`; without one (a server that does not say) the answering one. */
export const ownerKey = (s: ClientState, assistantId: string | undefined): string => assistantId ?? answeringId(s) ?? ""

/** The assistant named next to the state ("Speaking · T3"): who has the turn, unless it is the one that answers anyway. */
export const stripAssistantId = (s: ClientState): string | undefined => {
  if ((s.setup?.assistants.length ?? 0) < 2) return undefined // one assistant on the device: nothing to tell apart
  const id = s.woke?.assistantId ?? holderOf(s)
  return id !== undefined && id !== defaultAssistantId(s.setup) && idsOf(s.setup).includes(id) ? id : undefined
}

// ---- Words

const quote = (p: string) => `“${p}”`

/** The assistants that are reached by a phrase (not the one that answers without one). */
export const phrased = (setup: DeviceSetup): ReadonlyArray<SetupAssistant> => {
  const none = defaultAssistantId(setup)
  return setup.assistants.filter((a) => a.id !== none && a.phrases.length > 0)
}

/** The stage label while the device sleeps; `display` capitalises a phrase for the stage. */
export const asleepText = (setup: DeviceSetup | undefined, display: (phrase: string) => string): string => {
  const list = setup === undefined ? [] : phrased(setup)
  if (list.length === 0) return "Waiting for the wake phrase"
  if (list.length === 1) return `Say ${quote(display(list[0]!.phrases[0]!))}`
  if (list.length === 2) return `Say ${quote(display(list[0]!.phrases[0]!))} or ${quote(display(list[1]!.phrases[0]!))}`
  return "Say a wake phrase"
}

/** How one assistant is reached on this device (the menu's second line). */
export const reachText = (s: ClientState, id: string, started: boolean, display: (phrase: string) => string): string => {
  const setup = s.setup
  const a = assistantOf(s, id)
  if (setup === undefined || a === undefined) return ""
  const isDefault = defaultAssistantId(setup) === id
  let text: string
  if (isDefault) text = "Answers without a phrase"
  else if (a.phrases.length === 0) text = "No phrase on this device"
  else {
    const first = quote(display(a.phrases[0]!))
    text = `Say ${first}${a.phrases.length === 2 ? ` or ${quote(display(a.phrases[1]!))}` : a.phrases.length > 2 ? ` +${a.phrases.length - 1}` : ""}`
  }
  if (setup.withoutPhrase.mode === "typesafe" && setup.withoutPhrase.fallback === id) text += " · answers if none fits"
  if (holderOf(s) === id && !isDefault && started) text += " · answering now"
  return text
}

/** The top bar's name: who has the turn, else who answers, else "Auto", else the assistants. */
export const topBarName = (s: ClientState): string => {
  const setup = s.setup
  if (setup === undefined || setup.assistants.length === 0) return NO_ASSISTANT
  const held = holderOf(s)
  if (held !== undefined) return nameOf(s, held)
  const wp = setup.withoutPhrase
  if (wp.mode === "assistant") return nameOf(s, defaultAssistantId(setup) ?? setup.assistants[0]!.id)
  if (setup.assistants.length === 1) return setup.assistants[0]!.name
  if (wp.mode === "typesafe") return "Auto"
  const names = setup.assistants.map((a) => a.name)
  return names.length <= 2 ? names.join(" · ") : `${names.length} assistants`
}

/** What the sentence under the chat header says about where typed text and speech go. */
export const conversationNote = (s: ClientState, _started: boolean): string => {
  const viewed = viewedId(s)
  if (viewed === answeringId(s)) return "Each assistant keeps its own conversation on this device."
  const wp = s.setup?.withoutPhrase
  const speech = holderOf(s) ?? defaultAssistantId(s.setup)
  const reaches = speech !== undefined ? nameOf(s, speech) : wp?.mode === "typesafe" ? "whichever fits" : "the one you wake"
  return `Typed messages go to ${nameOf(s, viewed)}. Speaking still reaches ${reaches}.`
}

/** The tip of "New conversation": the others keep theirs. */
export const newConversationTip = (s: ClientState): string => {
  const list = s.setup?.assistants ?? []
  const viewed = viewedId(s)
  if (list.length < 2 || viewed === undefined) return "New conversation"
  const others = list.filter((a) => a.id !== viewed).map((a) => a.name)
  return `New conversation with ${nameOf(s, viewed)} (${others.join(" and ")} ${others.length > 1 ? "keep theirs" : "keeps its own"})`
}

/** The toast after "New conversation" from the dock. */
export const newConversationToast = (s: ClientState): string => {
  const list = s.setup?.assistants ?? []
  const viewed = viewedId(s)
  if (list.length < 2 || viewed === undefined) return "New conversation."
  const others = list.filter((a) => a.id !== viewed).map((a) => a.name)
  return `New conversation with ${nameOf(s, viewed)}. ${others.join(" and ")} ${list.length > 2 ? "keep their" : "keeps its"} own.`
}

// ---- Conversations

/** The page's turns of one assistant's conversation, oldest first. */
export const turnsOf = (s: ClientState, id: string | undefined): ReadonlyArray<TurnView> =>
  s.turns.filter((t) => (t.assistantId ?? answeringId(s) ?? "") === (id ?? ""))

/** Exchanges to show for one assistant in the switcher. */
export const exchangesOf = (s: ClientState, id: string): number => {
  const c = s.conversations[id]
  return c === undefined || !c.loaded ? c?.turns ?? 0 : turnsOf(s, id).length
}

/** Does the page need to ask the server for this conversation's history? */
export const needsRead = (s: ClientState, id: string | undefined): boolean => id !== undefined && s.conversations[id]?.loaded !== true

// ---- The device's profile, from its setup

const cache: { device?: DeviceProfile | undefined; setup?: DeviceSetup | undefined; overlay?: Partial<DeviceProfile>; value?: DeviceProfile } = {}

/**
 * The fields of the old profile the page still uses (microphone processing, output path, interrupting, captions),
 * from `device.setup` when the server has sent one: the setup is the source of truth in protocol 7. Cached by input,
 * so a change in the store that touches none of them returns the same object.
 */
export const profileFromSetup = (device: DeviceProfile | undefined, setup: DeviceSetup | undefined, overlay: Partial<DeviceProfile>): DeviceProfile => {
  if (cache.value !== undefined && cache.device === device && cache.setup === setup && cache.overlay === overlay) return cache.value
  const base = device ?? DEFAULT_DEVICE_PROFILE
  const fromSetup: DeviceProfile =
    setup === undefined
      ? base
      : {
        ...base,
        interruptMode: setup.interruptMode,
        captions: setup.captions.captions,
        speakReplies: setup.captions.speakTyped,
        echoCancellation: setup.audio.echoCancellation,
        noiseSuppression: setup.audio.noiseSuppression,
        autoGainControl: setup.audio.autoGainControl,
        outputPath: setup.audio.outputPath,
        prebufferMs: setup.audio.prebufferMs
      }
  const value = Object.keys(overlay).length === 0 ? fromSetup : { ...fromSetup, ...overlay }
  cache.device = device
  cache.setup = setup
  cache.overlay = overlay
  cache.value = value
  return value
}

// ---- Reducer pieces (state.ts)

type Snap = Pick<Snapshot, "history" | "conversation" | "setup" | "conversations">

/**
 * The part of the state a `welcome` sets: the setup, the conversations (the snapshot's history is the answering
 * assistant's, `snapshot.answering` when the server says, which may be a follow-up holder; the others are read when the
 * chat shows them) and the holder: `snapshot.holder`, who has the turn as the server says it (an armed assistant too,
 * whose history the snapshot does not carry); from a server that does not say, the follow-up holder, else nobody.
 */
export const atWelcome = (
  previous: ClientState,
  snapshot: Snap & Pick<Snapshot, "answering" | "holder">,
  toTurns: (history: ReadonlyArray<HistoryItem>) => ReadonlyArray<TurnView>
): Pick<ClientState, "setup" | "holder" | "conversations" | "turns"> => {
  const setup = snapshot.setup
  const probe = { setup, holder: snapshot.answering, ui: previous.ui } as unknown as ClientState
  const answering = answeringId(probe) ?? ""
  const list = snapshot.conversations ?? [{ assistantId: answering, id: snapshot.conversation.id, startedAt: snapshot.conversation.startedAt, turns: snapshot.history.length }]
  const conversations: Record<string, ConversationView> = {}
  for (const c of list) {
    const before = previous.conversations[c.assistantId]
    // The divider stays while it is the same conversation; a different one with nothing in it was replaced while this page was away.
    const divider = before === undefined ? undefined : before.id === c.id ? before.divider : c.assistantId === answering && snapshot.history.length === 0 ? "new" : undefined
    conversations[c.assistantId] = {
      id: c.id,
      startedAt: c.startedAt,
      turns: c.turns,
      loaded: c.assistantId === answering,
      ...(divider !== undefined ? { divider } : {})
    }
  }
  const turns = toTurns(snapshot.history).map((t) => ({ ...t, assistantId: answering }))
  // The server's holder when it says; else the history's assistant has the turn when it is not the one that answers anyway.
  const holder = snapshot.holder !== undefined
    ? snapshot.holder ?? undefined
    : answering === answeringId({ ...probe, holder: undefined }) ? undefined : holderOf(probe)
  return { setup, holder, conversations, turns }
}

/**
 * `device.setup`: the new setup; the holder is dropped only when it left the device. A new default does not move the
 * turn: the server says when it does (an accepted pick closes its windows, and the `state` that follows names the holder).
 */
export const onSetup = (s: ClientState, m: Extract<ServerMessage, { type: "device.setup" }>): ClientState => {
  const { type: _type, ...setup } = m
  const holder = s.holder !== undefined && !setup.assistants.some((a) => a.id === s.holder) ? undefined : s.holder
  return { ...s, setup, holder }
}

const withoutAssistant = (s: ClientState, key: string) => s.turns.filter((t) => (t.assistantId ?? answeringId(s) ?? "") !== key)

/** `conversation`: a conversation of one assistant began (new / idle) or went on (resumed). */
export const onConversation = (s: ClientState, m: Extract<ServerMessage, { type: "conversation" }>): ClientState => {
  const key = ownerKey(s, m.assistantId)
  const before = s.conversations[key]
  if (m.reason === "resumed") {
    return { ...s, conversations: { ...s.conversations, [key]: { id: m.id, startedAt: m.startedAt, turns: before?.turns ?? 0, loaded: before?.loaded ?? false, ...(before?.divider !== undefined ? { divider: before.divider } : {}) } } }
  }
  const stale = s.turns.flatMap((t) => (t.turnId === undefined || (t.assistantId ?? answeringId(s) ?? "") !== key ? [] : [t.turnId]))
  return {
    ...s,
    conversations: { ...s.conversations, [key]: { id: m.id, startedAt: m.startedAt, turns: 0, loaded: true, divider: m.reason } },
    turns: withoutAssistant(s, key),
    staleTurns: [...s.staleTurns, ...stale],
    liveTranscript: "",
    ui: { ...s.ui, unread: 0 }
  }
}

/** `conversation.history`: the whole history of one assistant's conversation replaces what the page holds of it (its running turn stays). */
export const onHistory = (
  s: ClientState,
  m: Extract<ServerMessage, { type: "conversation.history" }>,
  toTurns: (history: ReadonlyArray<HistoryItem>) => ReadonlyArray<TurnView>
): ClientState => {
  const key = m.assistantId
  // Turns are told apart by id, never by their text (the same question may be asked twice, and a stopped turn is
  // committed without a reply). The server names the turn whose exchange ends the history (`lastTurnId`): a turn
  // running on this page with that id is the page's live view of that exchange, so the exchange goes and the turn
  // stays. Every other running turn is not in the history yet (an exchange is committed when its turn ends): it stays.
  const mine = (t: TurnView) => (t.assistantId ?? answeringId(s) ?? "") === key && t.turnId !== undefined && t.outcome === undefined
  const live = m.lastTurnId === undefined ? undefined : s.turns.find((t) => mine(t) && t.turnId === m.lastTurnId)
  // That exchange starts at the history's last user message (each committed turn begins with its one user message).
  const from = live === undefined ? -1 : m.history.findLastIndex((h) => h.role === "user")
  const items = from < 0 ? m.history : m.history.slice(0, from)
  const fromHistory = toTurns(items).map((t) => ({ ...t, key: `${key}:${t.key}`, assistantId: key }))
  const running = s.turns.filter(mine)
  const others = withoutAssistant(s, key)
  const before = s.conversations[key]
  const info: ConversationInfo = { id: m.id, startedAt: before?.startedAt ?? Date.now() }
  return {
    ...s,
    turns: [...others, ...fromHistory, ...running],
    conversations: { ...s.conversations, [key]: { id: info.id, startedAt: info.startedAt, turns: fromHistory.length, loaded: true, ...(before !== undefined && before.id === m.id && before.divider !== undefined ? { divider: before.divider } : {}) } }
  }
}
