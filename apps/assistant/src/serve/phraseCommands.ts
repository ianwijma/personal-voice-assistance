import {
  buildCommandSet,
  type CommandSet,
  type DeviceControlService,
  hostCommandSet,
  type ModuleHost,
  type ModuleSnapshot,
  type NotifyEngine,
  type PhraseLanguage,
  type PhraseOutcome,
  phraseConflictIssues,
  Playback,
  type RegisteredAction,
  type ToolRegistry,
  type VolumeChange
} from "@pva/core"
import { type Assistant, REPLY_VOLUME, replyVolumeLevel, type ServerMessage, stepReplyVolume } from "@pva/protocol"
import { Effect } from "effect"
import type { SessionPhrases } from "./VoiceSession.ts"

/**
 * Serve mode's side of phrase commands (docs/PHRASES.md): each assistant's command set, built from the registry its
 * turns get (the modules it has on, without the tools and action tools it switched off or the risk policy refuses) and
 * cached per module snapshot, assistant and language, so the final of an utterance that is not taken reads a cached set;
 * the Health page's issues for the sets (source `phrases`); and what a device's voice session needs to run what took an
 * utterance. Everything is read when it is used.
 */
/** The issue source of the phrase sets' conflicts. */
export const PHRASE_ISSUE_SOURCE = "phrases"

export interface ServePhrasesOptions {
  readonly host: Pick<ModuleHost, "snapshot" | "gateway" | "pageText" | "service" | "issues">
  /** The assistants in effect now, by id. */
  readonly assistants: () => ReadonlyMap<string, Assistant>
  /** The registry an assistant's turn gets now (serve mode's `modulesFor`). */
  readonly registryOf: (snapshot: ModuleSnapshot, assistant: Assistant) => ToolRegistry["Service"]
  readonly language: () => PhraseLanguage
  readonly notify: Pick<NotifyEngine, "ringingOn" | "stopRinging" | "stopSpeech" | "press">
  /** The device's "while ringing" setting now (`place.ringingWithoutWake`, default on). */
  readonly ringingAllowed: (deviceId: string) => boolean
  /** The device's room now, if it has one. */
  readonly room: (deviceId: string) => string | undefined
  readonly volume: DeviceControlService
  readonly log: (line: string) => void
}

export interface ServePhrases {
  readonly commandsFor: (assistant: string | undefined) => CommandSet
  /** The Health page's `phrases` issues for the sets now. */
  readonly issues: () => ReadonlyArray<ReturnType<typeof phraseConflictIssues>[number]>
  /** Put them in the issue registry (coalesced: at most once per tick). */
  readonly refreshIssues: () => void
  /** What the voice session of `deviceId` needs (`VoiceSessionOptions.phrases`). */
  readonly forDevice: (deviceId: string | undefined) => SessionPhrases
}

export const makeServePhrases = (options: ServePhrasesOptions): ServePhrases => {
  const cache = new Map<string, { readonly snapshot: ModuleSnapshot; readonly assistant: Assistant; readonly language: PhraseLanguage; readonly set: CommandSet }>()
  const setOf = (assistant: Assistant, language: PhraseLanguage): CommandSet => {
    const snapshot = options.host.snapshot()
    const hit = cache.get(assistant.id)
    if (hit !== undefined && hit.snapshot === snapshot && hit.assistant === assistant && hit.language === language) return hit.set
    const set = buildCommandSet(language, options.registryOf(snapshot, assistant).actions ?? [])
    cache.set(assistant.id, { snapshot, assistant, language, set })
    // Assistants removed since: forget their sets (bounded by the assistants that exist).
    if (cache.size > options.assistants().size + 1) for (const id of cache.keys()) if (!options.assistants().has(id)) cache.delete(id)
    return set
  }
  const commandsFor = (id: string | undefined): CommandSet => {
    const language = options.language()
    const assistant = id === undefined ? undefined : options.assistants().get(id)
    return assistant === undefined ? hostCommandSet(language) : setOf(assistant, language)
  }
  const isPublished = (id: string, action: RegisteredAction): boolean => {
    const assistant = options.assistants().get(id)
    return assistant !== undefined && (options.registryOf(options.host.snapshot(), assistant).actions ?? []).includes(action)
  }
  const issues = () => {
    const language = options.language()
    return [...options.assistants().values()].filter((a) => a.on).flatMap((a) => phraseConflictIssues(a, setOf(a, language)))
  }
  let pending = false
  const refreshIssues = () => {
    if (pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      options.host.issues.set(PHRASE_ISSUE_SOURCE, issues())
    })
  }
  const describe = (o: PhraseOutcome) => {
    const what = o.taken.by === "ringing"
      ? `ringing ${o.taken.match.kind === "stop" ? "stop" : o.taken.match.label}`
      : o.taken.match.kind === "control" ? o.taken.match.control : o.taken.match.action.id
    return `${what}: ${o.did}${o.why !== undefined ? ` (${o.why})` : ""}`
  }
  const forDevice = (deviceId: string | undefined): SessionPhrases => ({
    language: options.language,
    commandsFor,
    ringing: () => (deviceId === undefined || !options.ringingAllowed(deviceId) ? undefined : options.notify.ringingOn(deviceId)),
    ports: {
      notify: () => options.notify,
      volume: (direction) => (deviceId === undefined ? Effect.succeed<VolumeChange>({ level: REPLY_VOLUME.default, atLimit: true }) : options.volume.changeReplyVolume(deviceId, direction)),
      playback: () => options.host.service(Playback),
      room: () => (deviceId === undefined ? undefined : options.room(deviceId)),
      gateway: () => options.host.gateway,
      isPublished,
      pageText: (moduleId, text, max) => options.host.pageText(moduleId, text, max)
    },
    onOutcome: (o) => options.log(`Phrase on ${deviceId ?? "a page without a device"}: ${describe(o)}`)
  })
  return { commandsFor, issues, refreshIssues, forDevice }
}

/** The most devices whose reply volume is kept (the oldest change is forgotten past it: that device is back at the default). */
export const MAX_KEPT_VOLUMES = 256

/**
 * `DeviceControl`'s reply volume (docs/PHRASES.md "Louder and quieter"): one level per device in memory, reset at a
 * restart; a change is sent as `output.volume` to every voice connection of the device; `levelOf` is what a page that says
 * hello is sent (nothing while it is the default).
 */
export const makeReplyVolumes = (send: (deviceId: string, message: ServerMessage) => void) => {
  const levels = new Map<string, number>()
  const set = (deviceId: string, level: number) => {
    levels.delete(deviceId)
    if (level === REPLY_VOLUME.default) return
    levels.set(deviceId, level)
    if (levels.size > MAX_KEPT_VOLUMES) levels.delete(levels.keys().next().value!)
  }
  const service: DeviceControlService = {
    replyVolume: (deviceId) => levels.get(deviceId) ?? REPLY_VOLUME.default,
    changeReplyVolume: (deviceId, change) =>
      Effect.sync(() => {
        const before = levels.get(deviceId) ?? REPLY_VOLUME.default
        const next = typeof change === "string"
          ? stepReplyVolume(before, change)
          : { level: replyVolumeLevel(change.to), atLimit: replyVolumeLevel(change.to) === before }
        set(deviceId, next.level)
        if (next.level !== before) send(deviceId, { type: "output.volume", volume: next.level })
        return next
      })
  }
  return { service, levelOf: (deviceId: string): number | undefined => levels.get(deviceId) }
}
