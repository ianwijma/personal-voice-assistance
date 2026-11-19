import {
  type CommandSet,
  type DeviceControlService,
  hostCommandSet,
  makePhraseSets,
  type ModuleHost,
  type ModulePart,
  type ModuleSnapshot,
  type NotifyEngine,
  offeredActions,
  type PhraseLanguage,
  type PhraseOutcome,
  type PhraseSets,
  Playback,
  type RegisteredAction,
  type VolumeChange
} from "@pva/core"
import { type Assistant, changeReplyVolume, NO_REPLY_VOLUMES, REPLY_VOLUME, type ReplyVolumes, replyVolumeOf, type ServerMessage } from "@pva/protocol"
import { Effect, type Scope } from "effect"
import type { SessionPhrases } from "./VoiceSession.ts"

/**
 * Serve mode's side of phrase commands (docs/PHRASES.md): each switched-on assistant's set, prepared ahead of use
 * (`makePhraseSets`: in bounded steps with real yields, whenever the modules, an assistant's choices or the language
 * change), keyed by what it depends on (the module snapshot's version, the language, the assistant's module choices;
 * never an assistant object's identity), so a recogniser's final only reads a ready set; the Health page's issues for the
 * sets (source `phrases`); and what a device's voice session needs to run what took an utterance. Everything is read when
 * it is used.
 */
/** The issue source of the phrase sets' conflicts. */
export const PHRASE_ISSUE_SOURCE = "phrases"

export interface ServePhrasesOptions {
  readonly host: Pick<ModuleHost, "snapshot" | "gateway" | "pageText" | "service" | "issues" | "subscribe">
  /** The assistants in effect now, by id. */
  readonly assistants: () => ReadonlyMap<string, Assistant>
  /** The parts an assistant's turns get now (serve mode's `partsFor`: the modules it has on, without its switched-off tools). */
  readonly partsOf: (snapshot: ModuleSnapshot, assistant: Assistant) => ReadonlyArray<ModulePart>
  readonly language: () => PhraseLanguage
  readonly notify: Pick<NotifyEngine, "ringingOn" | "stopRinging" | "stopSpeech" | "press">
  /** The device's "while ringing" setting now (`place.ringingWithoutWake`, default on). */
  readonly ringingAllowed: (deviceId: string) => boolean
  /** The device's room now, if it has one. */
  readonly room: (deviceId: string) => string | undefined
  readonly volume: DeviceControlService
  readonly log: (line: string) => void
  /** One preparation step's yield (tests). Default: a macrotask. */
  readonly yieldStep?: Effect.Effect<void>
}

export interface ServePhrases {
  /** `assistant`'s ready set, or the host's controls alone while it is not ready (or for no assistant). */
  readonly commandsFor: (assistant: string | undefined) => CommandSet
  readonly sets: PhraseSets
  /** Something the sets depend on changed (a settings save): prepare again in the background. */
  readonly changed: () => void
  /** What the voice session of `deviceId` needs (`VoiceSessionOptions.phrases`). */
  readonly forDevice: (deviceId: string | undefined) => SessionPhrases
}

export const makeServePhrases = (options: ServePhrasesOptions): Effect.Effect<ServePhrases, never, Scope.Scope> =>
  Effect.gen(function*() {
    /** What an assistant's choices mean for its set, once per assistant object (a final reads it). */
    const choices = new WeakMap<Assistant, string>()
    const choicesKey = (a: Assistant) => {
      let key = choices.get(a)
      if (key === undefined) {
        key = JSON.stringify([a.on, Object.entries(a.modules).map(([id, c]) => [id, c.on, [...c.offTools].sort()]).sort()])
        choices.set(a, key)
      }
      return key
    }
    const actionsOf = (id: string): ReadonlyArray<RegisteredAction> => {
      const assistant = options.assistants().get(id)
      // P8: every published action of the modules the assistant has on, whatever the risk policy says now. A phrase is
      // taken, and the gateway decides its action at execution on the policy of that moment (the same decision and
      // refusal sentence as the model's call of it), never "not taken" or "can't now" because of the policy.
      return assistant === undefined ? [] : offeredActions(options.partsOf(options.host.snapshot(), assistant).map((p) => p.module))
    }
    const sets = yield* makePhraseSets({
      language: options.language,
      assistants: () => [...options.assistants().values()].filter((a) => a.on).map((a) => ({ id: a.id, name: a.name })),
      inputKey: (id) => {
        const assistant = options.assistants().get(id)
        return assistant === undefined ? "none" : `${options.host.snapshot().version}|${options.language()}|${choicesKey(assistant)}`
      },
      actionsOf
    }, {
      ...(options.yieldStep !== undefined ? { yieldStep: options.yieldStep } : {}),
      onPrepared: () => options.host.issues.set(PHRASE_ISSUE_SOURCE, sets.issues())
    })
    options.host.subscribe(() => sets.changed())
    const commandsFor = (id: string | undefined): CommandSet => (id === undefined ? undefined : sets.ready(id)) ?? hostCommandSet(options.language())
    const isPublished = (id: string, action: RegisteredAction): boolean => actionsOf(id).includes(action)
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
    return { commandsFor, sets, changed: sets.changed, forDevice }
  })

/**
 * `DeviceControl`'s reply volume (docs/PHRASES.md "Louder and quieter"): the protocol's one state machine
 * (`changeReplyVolume`), in memory (reset at a restart); every send it names goes to the device's voice connections in the
 * same step; `levelOf` is what a page that says hello is sent (nothing while it is the default).
 */
export const makeReplyVolumes = (send: (deviceId: string, message: ServerMessage) => void) => {
  let volumes: ReplyVolumes = NO_REPLY_VOLUMES
  const service: DeviceControlService = {
    replyVolume: (deviceId) => replyVolumeOf(volumes, deviceId),
    changeReplyVolume: (deviceId, change) =>
      Effect.sync(() => {
        const t = changeReplyVolume(volumes, deviceId, change)
        volumes = t.volumes
        for (const s of t.sends) send(s.deviceId, { type: "output.volume", volume: s.volume })
        return t.change
      })
  }
  return { service, levelOf: (deviceId: string): number | undefined => volumes.get(deviceId) }
}
