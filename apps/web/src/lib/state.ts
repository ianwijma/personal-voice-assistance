import {
  type AdminState,
  type AssistantInfo,
  type DeviceTypeInfo,
  type AssistantState,
  type DeviceListInfo,
  type DeviceProfile,
  type DeviceProfileInfo,
  type DeviceSetup,
  type EngineStatus,
  type EngineSummary,
  type FrontendKindInfo,
  EnvInfo,
  type ErrorInfo,
  type HistoryItem,
  type JobInfo,
  type ModelSet,
  type ModuleInfo,
  type Role,
  type ServerMessage,
  type ServerMessageType,
  type SessionInfo,
  type SettingsSection,
  type TraceInfo,
  type TurnSource,
  type VaultInfo
} from "@pva/protocol"
import type { SettingsPath } from "./settingsTree.ts"
import { atWelcome, type ConversationView, onConversation, onHistory, onSetup, ownerKey, profileFromSetup } from "./voiceSetup.ts"

/**
 * Client state: one immutable value, changed only by `reducer`. Reply audio
 * never passes through here (it goes from the socket straight to the player),
 * and neither do audio levels (see `audio/levels.ts`).
 */

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "outdated"
export type AudioPhase = "off" | "starting" | "running" | "suspended" | "error"

export interface ToolView {
  readonly callId: string
  readonly tool: string
  readonly input: unknown
  readonly status: "running" | "ok" | "error"
  readonly ms?: number
  readonly error?: string
}

export interface ClauseView {
  readonly text: string
  readonly voice?: string
}

export interface TurnView {
  /** `t${turnId}` for live turns, `h${index}` for history. */
  readonly key: string
  readonly turnId?: number
  /** The assistant whose conversation the turn belongs to (protocol 7; one conversation per assistant). */
  readonly assistantId?: string
  readonly source: TurnSource
  readonly userText: string
  readonly spoken: boolean
  /** Spoken turns: one entry per clause (index = clause number). */
  readonly clauses: ReadonlyArray<ClauseView>
  /** Unspoken turns (streamed deltas) and history items. */
  readonly text: string
  /** Highest clause that started playing; -1 = none yet. */
  readonly playedClause: number
  readonly tools: ReadonlyArray<ToolView>
  readonly outcome?: "completed" | "interrupted" | "failed"
  readonly trace?: TraceInfo
  readonly error?: string
  /** From history: the reply was cut off (its text is what was heard). */
  readonly fromHistory?: boolean
}

export interface Toast {
  readonly id: number
  readonly message: string
  readonly tone: "error" | "info"
}

/** One line of the admin phrase tester (`wake.heard`). */
export interface HeardLine {
  readonly text: string
  /** The wake phrase it matched; absent = none. */
  readonly matched?: string
  /** The assistant took it (answered it, or the phrase alone made it listen); absent from an older server. */
  readonly accepted?: boolean
  readonly at: number
}

/**
 * What the phrase tester says about a line: matched a phrase, accepted without one (always listening, or the device
 * was already listening), ignored, or — from a server that does not say whether it was accepted — only that no
 * phrase matched.
 */
export type HeardOutcome = "matched" | "accepted" | "ignored" | "no-match"
export const heardOutcome = (l: HeardLine): HeardOutcome =>
  l.matched !== undefined ? "matched" : l.accepted === true ? "accepted" : l.accepted === false ? "ignored" : "no-match"

export const MAX_HEARD = 40

export interface PendingRequest {
  readonly kind: string
  readonly target?: string
}

export interface ClientState {
  readonly connection: {
    readonly status: ConnectionStatus
    /** Consecutive failed attempts since the last `welcome`. */
    readonly attempt: number
    /** Has a `welcome` ever arrived on this page? (first connect vs reconnect) */
    readonly everConnected: boolean
    readonly connectionId?: string
    readonly server?: { readonly name: string; readonly version: string }
    readonly protocol?: number
  }
  readonly session: {
    readonly role: Role
    readonly ownerPresent: boolean
    readonly serverState: AssistantState
    readonly stateTurnId?: number
  }
  readonly audio: {
    readonly phase: AudioPhase
    readonly micLive: boolean
    readonly error?: string
    /** The local player is playing this reply (from the player's started/finished/stopped). */
    readonly playing?: { readonly turnId: number }
  }
  /** What every connection knows about the engines (protocol 5 `engine.summary`): ready or not, the enabled voices. */
  readonly summary: EngineSummary
  /**
   * This connection's device profile as the server sent it (`snapshot.device`, `device.profile`); undefined on admin
   * connections and before `welcome`. `profileOverlay`: this page's own changes sent with `device.update` and not yet
   * confirmed (optimistic; any `device.profile` replaces them). Read the effective profile with `profileOf`.
   */
  readonly device: DeviceProfileInfo | undefined
  readonly profileOverlay: Partial<DeviceProfile>
  /** Admin access as this connection sees it (`snapshot.admin`, `admin.state`). */
  readonly admin: AdminState
  /** Counts `admin.state` messages, so a page can restart a countdown when the same `retryAfterMs` comes again. */
  readonly adminSeq: number
  /** The admin part of the state (`admin.snapshot`) has arrived for the current login. */
  readonly adminReady: boolean
  /** Admin: the front-end kinds with their defaults, and the remembered devices (most recently seen first). */
  readonly frontends: ReadonlyArray<FrontendKindInfo>
  readonly devices: ReadonlyArray<DeviceListInfo>
  /** Admin (protocol 7): the assistants with where they are used, and the device types with their defaults. */
  readonly assistants: ReadonlyArray<AssistantInfo>
  readonly deviceTypes: ReadonlyArray<DeviceTypeInfo>
  /** The audio owner said the wake phrase alone (`wake` with `armed`): "Listening…" until the next state change. */
  readonly woke: { readonly phrase: string; readonly assistantId?: string } | undefined
  /**
   * Protocol 7 (voice connections): who answers on this device (`snapshot.setup`, `device.setup`); undefined on admin
   * connections and from a server that does not send one.
   */
  readonly setup: DeviceSetup | undefined
  /** The assistant that has the turn now: a phrase woke it, or it answered last and may keep listening (docs/ASSISTANTS.md §7.2). */
  readonly holder: string | undefined
  /** One conversation per assistant on this device, by assistant id (`lib/voiceSetup.ts`). */
  readonly conversations: Readonly<Record<string, ConversationView>>
  /** Admin phrase tester: what the recogniser heard while it was on, oldest first. */
  readonly heard: ReadonlyArray<HeardLine>
  /** Admin only: the full engine status (`admin.snapshot.engine`, `engine`). */
  readonly engine: EngineStatus
  readonly modules: { readonly order: ReadonlyArray<string>; readonly byId: Readonly<Record<string, ModuleInfo>> }
  readonly sections: ReadonlyArray<SettingsSection>
  /** The key vault as this page sees it (`admin`: this page may change protected settings). */
  readonly vault: VaultInfo
  /** Settings set outside the UI (environment, `.env`); undefined: the server does not say (older server). */
  readonly env: EnvInfo | undefined
  /** Downloadable models per tool, and the running / recent jobs (downloads). */
  readonly models: ReadonlyArray<ModelSet>
  readonly jobs: ReadonlyArray<JobInfo>
  readonly turns: ReadonlyArray<TurnView>
  /**
   * Turn ids of the conversation that was replaced: late messages about them (the stopped turn's `turn.end`) are
   * dropped instead of showing up in the new conversation. A `turn.start` with the same id (ids restart at 1 per
   * conversation) is a turn of the new one.
   */
  readonly staleTurns: ReadonlyArray<number>
  /** Admin: the voice sessions, most recently active first (`admin.snapshot.sessions`, `sessions`). */
  readonly sessions: ReadonlyArray<SessionInfo>
  readonly liveTranscript: string
  readonly traces: ReadonlyArray<TraceInfo>
  readonly pending: Readonly<Record<string, PendingRequest>>
  readonly toasts: ReadonlyArray<Toast>
  readonly ui: {
    readonly chatOpen: boolean
    /** The conversation the chat shows when it is not the answering assistant's (reset when the chat opens or closes). */
    readonly chatView: string | undefined
    /** Voice front end: the settings sheet. */
    readonly sheetOpen: boolean
    /**
     * Admin: the settings screen (docs/SETTINGS-UI.md §3.1) is the admin page itself, so it is always open there;
     * its path is mirrored in the URL hash (`#settings/…`).
     */
    readonly settingsOpen: boolean
    readonly settingsPath: SettingsPath
    /** The settings page on screen has unsaved edits. */
    readonly settingsDirty: boolean
    /** A navigation held for "Leave without saving?" (`lib/settingsTree.ts` `navigateSettings`). */
    readonly settingsLeave?: SettingsPath | "close" | undefined
    readonly unread: number
    readonly shortcutsOpen: boolean
  }
}

export const MAX_TURNS = 300
export const MAX_TRACES = 50
export const MAX_TOASTS = 3

export const emptyEngine: EngineStatus = { state: "starting", problems: [], reloadPending: false, reloadPendingFor: [], engines: [], voices: [] }
/** Before the admin snapshot: no vault known, and this page is not admin. */
export const noVault: VaultInfo = { state: "none", admin: false }
export const noAdmin: AdminState = { enabled: true, loggedIn: false }
export const emptySummary: EngineSummary = { ready: false, state: "starting", voices: [] }

export const initialState: ClientState = {
  connection: { status: "connecting", attempt: 0, everConnected: false },
  session: { role: "observer", ownerPresent: false, serverState: "idle" },
  audio: { phase: "off", micLive: true },
  summary: emptySummary,
  device: undefined,
  profileOverlay: {},
  admin: noAdmin,
  adminSeq: 0,
  adminReady: false,
  frontends: [],
  devices: [],
  assistants: [],
  deviceTypes: [],
  woke: undefined,
  setup: undefined,
  holder: undefined,
  conversations: {},
  heard: [],
  engine: emptyEngine,
  modules: { order: [], byId: {} },
  sections: [],
  vault: noVault,
  env: undefined,
  models: [],
  jobs: [],
  turns: [],
  staleTurns: [],
  sessions: [],
  liveTranscript: "",
  traces: [],
  pending: {},
  toasts: [],
  ui: { chatOpen: false, chatView: undefined, sheetOpen: false, settingsOpen: false, settingsPath: [], settingsDirty: false, unread: 0, shortcutsOpen: false }
}

/** The admin part of the state, emptied at logout and when a session ends. */
const adminPart = {
  engine: emptyEngine,
  modules: initialState.modules,
  sections: initialState.sections,
  vault: noVault,
  env: undefined,
  models: initialState.models,
  jobs: initialState.jobs,
  traces: initialState.traces,
  frontends: initialState.frontends,
  devices: initialState.devices,
  assistants: initialState.assistants,
  deviceTypes: initialState.deviceTypes,
  sessions: initialState.sessions,
  heard: initialState.heard,
  adminReady: false
} satisfies Partial<ClientState>

/** Things that happen in the page rather than on the server. */
export type LocalAction =
  | { readonly type: "local/connection"; readonly status: ConnectionStatus; readonly attempt: number }
  | { readonly type: "local/audio"; readonly phase: AudioPhase; readonly error?: string }
  | { readonly type: "local/mic"; readonly live: boolean }
  | { readonly type: "local/profile-overlay"; readonly patch: Partial<DeviceProfile> }
  | { readonly type: "local/profile-overlay-clear" }
  | { readonly type: "local/heard-clear" }
  | { readonly type: "local/playing"; readonly turnId: number | undefined }
  | { readonly type: "local/request"; readonly requestId: string; readonly kind: string; readonly target?: string }
  | { readonly type: "local/request-done"; readonly requestId: string }
  | { readonly type: "local/toast"; readonly message: string; readonly tone: "error" | "info" }
  | { readonly type: "local/toast-dismiss"; readonly id: number }
  | { readonly type: "local/ui"; readonly patch: Partial<ClientState["ui"]> }
  | { readonly type: "local/socket-lost" }

export type Action = ServerMessage | LocalAction

let toastSeq = 0

const addToast = (s: ClientState, message: string, tone: Toast["tone"]): ClientState => ({
  ...s,
  toasts: [...s.toasts, { id: ++toastSeq, message, tone }].slice(-MAX_TOASTS)
})

const newTurn = (key: string, fields: Partial<TurnView> & { source: TurnSource }): TurnView => ({
  key,
  userText: "",
  spoken: false,
  clauses: [],
  text: "",
  playedClause: -1,
  tools: [],
  ...fields
})

/** History items → turn views: a user item starts a turn, an assistant item completes it. */
export const historyToTurns = (history: ReadonlyArray<HistoryItem>): ReadonlyArray<TurnView> => {
  const turns: Array<TurnView> = []
  history.forEach((item, i) => {
    if (item.role === "user") {
      // A user message followed by another one was stopped before any reply.
      const prev = turns.at(-1)
      if (prev !== undefined && prev.text === "" && prev.outcome === undefined) {
        turns[turns.length - 1] = { ...prev, outcome: "interrupted" }
      }
      turns.push(newTurn(`h${i}`, { source: "voice", userText: item.text, fromHistory: true }))
      return
    }
    const last = turns.at(-1)
    const assistant: Partial<TurnView> = {
      text: item.text,
      tools: item.tools.map((t, k) => ({ callId: `h${i}-${k}`, tool: t.name, input: null, status: t.ok ? "ok" : "error" })),
      outcome: item.interrupted ? "interrupted" : "completed"
    }
    if (last !== undefined && last.text === "" && last.outcome === undefined) {
      turns[turns.length - 1] = { ...last, ...assistant }
    } else {
      turns.push(newTurn(`h${i}`, { source: "voice", fromHistory: true, ...assistant }))
    }
  })
  return turns
}

/** Apply `f` to the turn with `turnId`, creating its view if this tab joined mid-turn. */
const withTurn = (
  s: ClientState,
  turnId: number,
  f: (t: TurnView) => TurnView,
  create: () => TurnView = () => newTurn(`t${turnId}`, { turnId, source: "voice", spoken: true })
): ClientState => {
  const idx = findTurn(s.turns, turnId)
  if (idx === -1) {
    if (s.staleTurns.includes(turnId)) return s // a turn of the conversation that was replaced
    return { ...s, turns: capTurns([...s.turns, f(create())]) }
  }
  const turns = s.turns.slice()
  turns[idx] = f(turns[idx]!)
  return { ...s, turns }
}

const findTurn = (turns: ReadonlyArray<TurnView>, turnId: number): number => {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.turnId === turnId) return i
  return -1
}

const capTurns = (turns: ReadonlyArray<TurnView>) => (turns.length > MAX_TURNS ? turns.slice(-MAX_TURNS) : turns)

const upsertModule = (s: ClientState, module: ModuleInfo): ClientState => {
  const current = s.modules.byId[module.id]
  if (current !== undefined && current.revision > module.revision) return s // keep the highest revision seen
  return {
    ...s,
    modules: {
      order: current === undefined ? [...s.modules.order, module.id] : s.modules.order,
      byId: { ...s.modules.byId, [module.id]: module }
    }
  }
}

const upsertSection = (s: ClientState, section: SettingsSection): ClientState => {
  const idx = s.sections.findIndex((x) => x.id === section.id)
  if (idx === -1) return { ...s, sections: [...s.sections, section] }
  if (s.sections[idx]!.revision > section.revision) return s
  const sections = s.sections.slice()
  sections[idx] = section
  return { ...s, sections }
}

const describeError = (e: ErrorInfo) => e.message

type ServerHandlers = { readonly [T in ServerMessageType]: (s: ClientState, m: Extract<ServerMessage, { type: T }>) => ClientState }

const server: ServerHandlers = {
  welcome: (s, m) => ({
    ...initialState,
    connection: {
      status: "open",
      attempt: 0,
      everConnected: true,
      connectionId: m.connectionId,
      server: m.server,
      protocol: m.protocol
    },
    session: { role: m.snapshot.role, ownerPresent: m.snapshot.ownerPresent, serverState: m.snapshot.state },
    // The audio graph belongs to the page and survives reconnects; the player was flushed on loss.
    audio: withoutPlaying(s.audio),
    summary: m.snapshot.engine,
    device: m.snapshot.device,
    admin: m.snapshot.admin,
    adminSeq: s.adminSeq + 1,
    // A reconnect with a valid admin token keeps the admin data on screen until the new `admin.snapshot` replaces it.
    ...(m.snapshot.admin.loggedIn ? pickAdmin(s) : {}),
    ...atWelcome(s, m.snapshot, historyToTurns),
    toasts: s.toasts,
    ui: s.ui
  }),
  "admin.snapshot": (s, m) => ({
    ...s,
    engine: m.snapshot.engine,
    modules: { order: m.snapshot.modules.map((x) => x.id), byId: Object.fromEntries(m.snapshot.modules.map((x) => [x.id, x])) },
    sections: m.snapshot.sections,
    vault: m.snapshot.vault,
    env: m.snapshot.env,
    models: m.snapshot.models,
    jobs: m.snapshot.jobs,
    traces: m.snapshot.traces.slice(-MAX_TRACES),
    frontends: m.snapshot.frontends,
    devices: m.snapshot.devices,
    assistants: m.snapshot.assistants ?? [],
    deviceTypes: m.snapshot.deviceTypes ?? [],
    sessions: m.snapshot.sessions,
    adminReady: true
  }),
  "engine.summary": (s, m) => ({ ...s, summary: m.engine }),
  "admin.state": (s, m) => {
    const next = { ...s, admin: m.admin, adminSeq: s.adminSeq + 1 }
    return m.admin.loggedIn ? next : { ...next, ...adminPart }
  },
  "device.profile": (s, m) => ({
    ...s,
    device: m.deviceId === undefined ? { profile: m.profile, editable: m.editable } : { deviceId: m.deviceId, profile: m.profile, editable: m.editable },
    profileOverlay: {}
  }),
  frontends: (s, m) => ({ ...s, frontends: m.frontends }),
  devices: (s, m) => ({ ...s, devices: m.devices }),
  // Protocol 6/7. A new conversation (New conversation, or after being quiet for a while) of one assistant starts with an
  // empty chat and a divider; `resumed` only says which conversation goes on (the chat stays).
  conversation: onConversation,
  sessions: (s, m) => ({ ...s, sessions: m.sessions }),
  // Admin: a session's finished turn (admin gets no turn.end); turn ids repeat across sessions, so it is appended.
  trace: (s, m) => ({ ...s, traces: [...s.traces, m.trace].slice(-MAX_TRACES) }),
  // The phrase and the request in one sentence (`armed: false`): a turn follows, nothing to show.
  wake: (s, m) =>
    m.armed ? { ...s, woke: m.assistantId === undefined ? { phrase: m.phrase } : { phrase: m.phrase, assistantId: m.assistantId }, holder: m.assistantId ?? s.holder } : s,
  "wake.heard": (s, m) => ({
    ...s,
    heard: [
      ...s.heard,
      { text: m.text, ...(m.matched === undefined ? {} : { matched: m.matched }), ...(m.accepted === undefined ? {} : { accepted: m.accepted }), at: m.at }
    ].slice(-MAX_HEARD)
  }),
  session: (s, m) => ({ ...s, session: { ...s.session, role: m.role, ownerPresent: m.ownerPresent } }),
  state: (s, m) => {
    const { stateTurnId: _previous, ...rest } = s.session
    const session = m.turnId === undefined ? { ...rest, serverState: m.state } : { ...rest, serverState: m.state, stateTurnId: m.turnId }
    // "Listening…" after the wake phrase lasts until the assistant hears something, or falls asleep again.
    // Asleep or idle: nobody has the turn any more.
    const sleeping = m.state === "asleep" || m.state === "idle"
    // The server is the one authority on who has the turn (protocol 7 `holder`: the turn in flight or the utterance being
    // heard, else an open window; also sent when only it changed). The page shows it and does not guess.
    const told = m.holder === undefined ? s.holder : m.holder ?? undefined
    return { ...s, session, woke: m.state === "listening" && m.holder !== null ? s.woke : undefined, holder: sleeping ? undefined : told }
  },
  transcript: (s, m) => (s.liveTranscript === m.text ? s : { ...s, liveTranscript: m.text }),
  "turn.start": (s, m) => {
    const fresh = s.staleTurns.includes(m.turnId) ? { ...s, staleTurns: s.staleTurns.filter((id) => id !== m.turnId) } : s
    const owner = ownerKey(fresh, m.assistantId)
    const next = withTurn(
      fresh,
      m.turnId,
      (t) => ({ ...t, assistantId: owner, source: m.source, userText: m.userText, spoken: m.spoken }),
      () => newTurn(`t${m.turnId}`, { turnId: m.turnId, assistantId: owner, source: m.source, userText: m.userText, spoken: m.spoken })
    )
    return { ...next, liveTranscript: "", woke: undefined, holder: m.assistantId ?? next.holder }
  },
  "assistant.text": (s, m) =>
    withTurn(
      s,
      m.turnId,
      (t) => {
        if (m.clause === null) return { ...t, text: t.text + m.text }
        const clauses = t.clauses.slice()
        while (clauses.length < m.clause) clauses.push({ text: "" })
        clauses[m.clause] = m.voice === undefined ? { text: m.text } : { text: m.text, voice: m.voice }
        return { ...t, spoken: true, clauses }
      },
      () => newTurn(`t${m.turnId}`, { turnId: m.turnId, assistantId: ownerKey(s, m.assistantId), source: "voice", spoken: m.clause !== null })
    ),
  "assistant.playing": (s, m) => withTurn(s, m.turnId, (t) => (m.clause > t.playedClause ? { ...t, playedClause: m.clause } : t)),
  "tool.start": (s, m) =>
    withTurn(s, m.turnId, (t) => ({
      ...t,
      tools: [...t.tools.filter((x) => x.callId !== m.callId), { callId: m.callId, tool: m.tool, input: m.input, status: "running" }]
    })),
  "tool.end": (s, m) =>
    withTurn(s, m.turnId, (t) => ({
      ...t,
      tools: t.tools.some((x) => x.callId === m.callId)
        ? t.tools.map((x) =>
          x.callId === m.callId
            ? { ...x, status: m.ok ? "ok" : "error", ms: m.ms, ...(m.error === undefined ? {} : { error: m.error }) }
            : x
        )
        : [...t.tools, {
          callId: m.callId,
          tool: "tool",
          input: null,
          status: m.ok ? "ok" : "error",
          ms: m.ms,
          ...(m.error === undefined ? {} : { error: m.error })
        }]
    })),
  "turn.end": (s, m) => {
    if (findTurn(s.turns, m.turnId) === -1 && s.staleTurns.includes(m.turnId)) return s
    const next = withTurn(s, m.turnId, (t) => ({ ...t, outcome: m.outcome, trace: m.trace }))
    const traces = [...next.traces.filter((t) => t.turnId !== m.trace.turnId), m.trace].slice(-MAX_TRACES)
    const unread = next.ui.chatOpen ? next.ui.unread : next.ui.unread + 1
    return { ...next, traces, ui: { ...next.ui, unread } }
  },
  // Reply audio control goes to the player, not the store.
  "reply.start": (s) => s,
  "reply.end": (s) => s,
  "reply.stop": (s) => s,
  "module.changed": (s, m) => upsertModule(s, m.module),
  "section.changed": (s, m) => upsertSection(s, m.section),
  engine: (s, m) => ({ ...s, engine: m.engine }),
  vault: (s, m) => ({ ...s, vault: m.vault }),
  env: (s, m) => ({ ...s, env: m.env }),
  models: (s, m) => ({ ...s, models: m.models }),
  job: (s, m) => {
    const i = s.jobs.findIndex((j) => j.id === m.job.id)
    if (i === -1) return { ...s, jobs: [...s.jobs, m.job].slice(-20) }
    const jobs = s.jobs.slice()
    jobs[i] = m.job
    return { ...s, jobs }
  },
  result: (s, m) => {
    if (!(m.requestId in s.pending)) return s
    const { [m.requestId]: _done, ...pending } = s.pending
    return { ...s, pending }
  },
  error: (s, m) => {
    const e = m.error
    // Refused Start: the client closes the microphone and shows it as the start error (`client.ts`), not as a toast.
    if (e.code === "sessions_full") return s
    let next = s
    if (e.turnId !== undefined) next = withTurn(next, e.turnId, (t) => ({ ...t, error: describeError(e) }))
    return addToast(next, describeError(e), e.code === "mic_gap" ? "info" : "error")
  },
  pong: (s) => s,
  // Protocol 7: the voice page's (WP-8; `lib/voiceSetup.ts`). `assistants` and `device.types` are WP-6a's, below.
  "device.setup": onSetup,
  "conversation.history": (s, m) => onHistory(s, m, historyToTurns),
  assistants: (s, m) => ({ ...s, assistants: m.assistants }),
  "device.types": (s, m) => ({ ...s, deviceTypes: m.types })
}

const local = (s: ClientState, a: LocalAction): ClientState => {
  switch (a.type) {
    case "local/connection":
      // Outdated: the page shows its own notice with Reload, so the server's "out of date" error toast goes.
      return a.status === "outdated"
        ? { ...s, toasts: [], connection: { ...s.connection, status: a.status, attempt: a.attempt } }
        : { ...s, connection: { ...s.connection, status: a.status, attempt: a.attempt } }
    case "local/socket-lost":
      // Requests in flight will never be answered on this socket; the player was flushed.
      return { ...s, pending: {}, audio: withoutPlaying(s.audio), liveTranscript: "" }
    case "local/audio": {
      const { error: _error, ...rest } = s.audio
      const base = a.phase === "off" || a.phase === "error" ? { ...withoutPlaying(rest), micLive: true } : rest
      return { ...s, audio: a.error === undefined ? { ...base, phase: a.phase } : { ...base, phase: a.phase, error: a.error } }
    }
    case "local/mic":
      return { ...s, audio: { ...s.audio, micLive: a.live } }
    case "local/profile-overlay":
      return { ...s, profileOverlay: { ...s.profileOverlay, ...a.patch } }
    case "local/profile-overlay-clear":
      return Object.keys(s.profileOverlay).length === 0 ? s : { ...s, profileOverlay: {} }
    case "local/heard-clear":
      return s.heard.length === 0 ? s : { ...s, heard: [] }
    case "local/playing":
      if (a.turnId === undefined) return s.audio.playing === undefined ? s : { ...s, audio: withoutPlaying(s.audio) }
      return { ...s, audio: { ...s.audio, playing: { turnId: a.turnId } } }
    case "local/request":
      return {
        ...s,
        pending: { ...s.pending, [a.requestId]: a.target === undefined ? { kind: a.kind } : { kind: a.kind, target: a.target } }
      }
    case "local/request-done": {
      if (!(a.requestId in s.pending)) return s
      const { [a.requestId]: _done, ...pending } = s.pending
      return { ...s, pending }
    }
    case "local/toast":
      return addToast(s, a.message, a.tone)
    case "local/toast-dismiss":
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) }
    case "local/ui": {
      const ui = { ...s.ui, ...a.patch }
      // Opening or closing the chat goes back to the answering assistant's conversation.
      if (a.patch.chatOpen !== undefined && !("chatView" in a.patch)) ui.chatView = undefined
      if (a.patch.chatOpen === true) ui.unread = 0
      // One modal panel at a time: opening the settings sheet closes Help, and the other way round.
      if (a.patch.sheetOpen === true && a.patch.shortcutsOpen === undefined) ui.shortcutsOpen = false
      if (a.patch.shortcutsOpen === true && a.patch.sheetOpen === undefined) ui.sheetOpen = false
      return { ...s, ui }
    }
  }
}

function pickAdmin(s: ClientState): Partial<ClientState> {
  return {
    engine: s.engine,
    modules: s.modules,
    sections: s.sections,
    vault: s.vault,
    env: s.env,
    models: s.models,
    jobs: s.jobs,
    traces: s.traces,
    frontends: s.frontends,
    devices: s.devices,
    assistants: s.assistants,
    deviceTypes: s.deviceTypes,
    sessions: s.sessions,
    heard: s.heard,
    adminReady: s.adminReady
  }
}

function withoutPlaying(audio: ClientState["audio"]): ClientState["audio"] {
  const { playing: _playing, ...rest } = audio
  return rest
}

const isLocal = (a: Action): a is LocalAction => a.type.startsWith("local/")

/** The one way the client state changes. Pure. */
export const reducer = (s: ClientState, a: Action): ClientState => {
  if (isLocal(a)) return local(s, a)
  const handler = server[a.type] as (s: ClientState, m: ServerMessage) => ClientState
  return handler(s, a)
}

// ---- Derived values (selectors) ----

/** This connection's effective device profile: the server's, with this page's unconfirmed changes on top. */
export const profileOf = (s: ClientState): DeviceProfile => profileFromSetup(s.device?.profile, s.setup, s.profileOverlay)

/** The engines failed and the key vault is locked: unlocking is the fix (the server reloads them). */
export const engineNeedsKeys = (s: ClientState): boolean => s.engine.state === "failed" && s.vault.state === "locked"

export const isOwner = (s: ClientState) => s.session.role === "owner"

/** The modules in catalog order. */
export const modulesInOrder = (s: ClientState): ReadonlyArray<ModuleInfo> =>
  s.modules.order.flatMap((id) => {
    const m = s.modules.byId[id]
    return m === undefined ? [] : [m]
  })

export type VisualState =
  | "disconnected"
  | "error"
  | "not-started"
  | "speaking"
  | "thinking"
  | "muted"
  | "hearing"
  | "listening"
  | "asleep"
  | "idle"

/** The visualiser's state (docs/UI-AND-MODULES.md §3.3): first matching row wins. */
export const visualState = (s: ClientState): VisualState => {
  if (s.connection.status !== "open") return s.connection.status === "outdated" ? "error" : "disconnected"
  if (s.audio.phase === "error") return "error"
  const owner = isOwner(s) && s.audio.phase !== "off"
  if (!owner && !s.session.ownerPresent) return "not-started"
  // The local player is the earliest signal that a reply is audible; the server's state covers observers
  // and the moment between the player finishing and the server's next state.
  if ((owner && s.audio.playing !== undefined) || s.session.serverState === "speaking") return "speaking"
  if (s.session.serverState === "thinking") return "thinking"
  if (owner && !s.audio.micLive) return "muted"
  if (s.session.serverState === "hearing") return "hearing"
  if (s.session.serverState === "listening") return "listening"
  // Wake-phrase mode: listening without reacting. The phrase alone ("Hey Jeff") shows as listening at once.
  if (s.session.serverState === "asleep") return s.woke !== undefined ? "listening" : "asleep"
  return "idle"
}

/** The latency the readout shows: the last spoken turn's first sound, or a text turn's first token. */
export const firstSoundMs = (t: TraceInfo): { readonly ms: number; readonly label: "audible" | "first token" } | undefined => {
  if (t.marks.playbackStart !== undefined) {
    return { ms: t.marks.playbackStart + (t.client?.outputLatencyMs ?? 0), label: "audible" }
  }
  if (t.marks.llmFirstToken !== undefined && t.mode === "text") return { ms: t.marks.llmFirstToken, label: "first token" }
  return undefined
}

export const lastLatency = (s: ClientState) => {
  for (let i = s.traces.length - 1; i >= 0; i--) {
    const v = firstSoundMs(s.traces[i]!)
    if (v !== undefined) return v
  }
  return undefined
}

/** "Hey Jeff" for "hey jeff": a phrase as shown on the stage (one that already has capitals is shown as it is). */
export const displayPhrase = (phrase: string): string => /\p{Lu}/u.test(phrase) ? phrase : phrase.replace(/(^|\s)(\p{L})/gu, (_m, space: string, letter: string) => space + letter.toUpperCase())

export const turnById = (s: ClientState, turnId: number | undefined): TurnView | undefined => {
  if (turnId === undefined) return undefined
  const idx = findTurn(s.turns, turnId)
  return idx === -1 ? undefined : s.turns[idx]
}

/** The running download of a model, if any. */
export const runningJob = (s: ClientState, tool: string, target: string): JobInfo | undefined =>
  s.jobs.find((j) => j.tool === tool && j.target === target && j.state === "running")

/** The newest job of a model (running or finished). */
export const lastJob = (s: ClientState, tool: string, target: string): JobInfo | undefined =>
  [...s.jobs].reverse().find((j) => j.tool === tool && j.target === target)
