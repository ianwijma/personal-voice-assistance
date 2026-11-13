import type {
  AssistantState,
  EngineStatus,
  ErrorInfo,
  HistoryItem,
  InterruptMode,
  ModuleInfo,
  Role,
  ServerMessage,
  ServerMessageType,
  SettingsSection,
  TraceInfo,
  TurnSource,
  VaultInfo
} from "@pva/protocol"

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
    readonly interruptMode: InterruptMode
  }
  readonly engine: EngineStatus
  readonly modules: { readonly order: ReadonlyArray<string>; readonly byId: Readonly<Record<string, ModuleInfo>> }
  readonly sections: ReadonlyArray<SettingsSection>
  /** The key vault as this page sees it (`admin`: this page may change protected settings). */
  readonly vault: VaultInfo
  readonly turns: ReadonlyArray<TurnView>
  readonly liveTranscript: string
  readonly traces: ReadonlyArray<TraceInfo>
  readonly pending: Readonly<Record<string, PendingRequest>>
  readonly toasts: ReadonlyArray<Toast>
  readonly ui: {
    readonly chatOpen: boolean
    readonly optionsOpen: boolean
    readonly optionsTab: string
    readonly unread: number
    readonly shortcutsOpen: boolean
  }
}

export const MAX_TURNS = 300
export const MAX_TRACES = 50
export const MAX_TOASTS = 3

export const emptyEngine: EngineStatus = { state: "starting", problems: [], reloadPending: false, engines: [], voices: [] }
/** A server that sends no vault (or has none yet): every page may change everything. */
export const noVault: VaultInfo = { state: "none", admin: true }

export const initialState: ClientState = {
  connection: { status: "connecting", attempt: 0, everConnected: false },
  session: { role: "observer", ownerPresent: false, serverState: "idle" },
  audio: { phase: "off", micLive: true, interruptMode: "confirm" },
  engine: emptyEngine,
  modules: { order: [], byId: {} },
  sections: [],
  vault: noVault,
  turns: [],
  liveTranscript: "",
  traces: [],
  pending: {},
  toasts: [],
  ui: { chatOpen: false, optionsOpen: false, optionsTab: "modules", unread: 0, shortcutsOpen: false }
}

/** Things that happen in the page rather than on the server. */
export type LocalAction =
  | { readonly type: "local/connection"; readonly status: ConnectionStatus; readonly attempt: number }
  | { readonly type: "local/audio"; readonly phase: AudioPhase; readonly error?: string }
  | { readonly type: "local/mic"; readonly live: boolean }
  | { readonly type: "local/interrupt-mode"; readonly mode: InterruptMode }
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
  if (idx === -1) return { ...s, turns: capTurns([...s.turns, f(create())]) }
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
    engine: m.snapshot.engine,
    modules: { order: m.snapshot.modules.map((x) => x.id), byId: Object.fromEntries(m.snapshot.modules.map((x) => [x.id, x])) },
    sections: m.snapshot.sections,
    vault: m.snapshot.vault ?? noVault,
    turns: historyToTurns(m.snapshot.history),
    traces: m.snapshot.traces.slice(-MAX_TRACES),
    toasts: s.toasts,
    ui: s.ui
  }),
  session: (s, m) => ({ ...s, session: { ...s.session, role: m.role, ownerPresent: m.ownerPresent } }),
  state: (s, m) => {
    const { stateTurnId: _previous, ...rest } = s.session
    return { ...s, session: m.turnId === undefined ? { ...rest, serverState: m.state } : { ...rest, serverState: m.state, stateTurnId: m.turnId } }
  },
  transcript: (s, m) => (s.liveTranscript === m.text ? s : { ...s, liveTranscript: m.text }),
  "turn.start": (s, m) => {
    const next = withTurn(
      s,
      m.turnId,
      (t) => ({ ...t, source: m.source, userText: m.userText, spoken: m.spoken }),
      () => newTurn(`t${m.turnId}`, { turnId: m.turnId, source: m.source, userText: m.userText, spoken: m.spoken })
    )
    return { ...next, liveTranscript: "" }
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
      () => newTurn(`t${m.turnId}`, { turnId: m.turnId, source: "voice", spoken: m.clause !== null })
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
  result: (s, m) => {
    if (!(m.requestId in s.pending)) return s
    const { [m.requestId]: _done, ...pending } = s.pending
    return { ...s, pending }
  },
  error: (s, m) => {
    const e = m.error
    let next = s
    if (e.turnId !== undefined) next = withTurn(next, e.turnId, (t) => ({ ...t, error: describeError(e) }))
    return addToast(next, describeError(e), e.code === "mic_gap" ? "info" : "error")
  },
  pong: (s) => s
}

const local = (s: ClientState, a: LocalAction): ClientState => {
  switch (a.type) {
    case "local/connection":
      return { ...s, connection: { ...s.connection, status: a.status, attempt: a.attempt } }
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
    case "local/interrupt-mode":
      return { ...s, audio: { ...s.audio, interruptMode: a.mode } }
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
      if (a.patch.chatOpen === true) ui.unread = 0
      return { ...s, ui }
    }
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

/** May this page change `item` (a module or settings section)? Protected items need admin access. */
export const canChange = (s: ClientState, item: { readonly protected?: boolean } | undefined): boolean =>
  item?.protected !== true || s.vault.admin

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

/** The voice name to show next to SPEAKING: only when more than one voice is enabled. */
export const speakingVoice = (s: ClientState): string | undefined => {
  if (s.engine.voices.filter((v) => v.enabled).length < 2) return undefined
  const turnId = s.audio.playing?.turnId ?? s.session.stateTurnId
  if (turnId === undefined) return undefined
  const idx = findTurn(s.turns, turnId)
  if (idx === -1) return undefined
  const t = s.turns[idx]!
  const clause = t.clauses[Math.max(0, t.playedClause)]
  return clause?.voice ?? s.engine.voices.find((v) => v.isDefault)?.name
}

export const turnById = (s: ClientState, turnId: number | undefined): TurnView | undefined => {
  if (turnId === undefined) return undefined
  const idx = findTurn(s.turns, turnId)
  return idx === -1 ? undefined : s.turns[idx]
}
