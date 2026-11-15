import { type HostResult, type VoiceRef, voiceKey } from "@pva/core"
import type { DefaultVoice, DefaultVoiceSaved } from "@pva/protocol"
import { ConfigProvider, Effect } from "effect"
import { ASSISTANT_VOICE, assistantVoice, DEFAULT_ASSISTANT_VOICE } from "../voiceSelection.ts"
import type { Engine } from "./Engine.ts"
import type { SectionUpdate, Sections } from "./sections.ts"
import { ApiFailure, type VoiceCatalog } from "./VoiceCatalog.ts"

/**
 * The assistant's voice as the API reads and saves it (docs/VOICE-PROVIDERS.md §5.8): resolved from the settings
 * like the engine build does (`ASSISTANT_VOICE`, else the migration), saved as `ASSISTANT_VOICE` through the
 * settings store.
 */

export interface AssistantVoice {
  /** The assistant's voice as saved now (what the next build speaks with). */
  readonly ref: Effect.Effect<VoiceRef>
  readonly get: Effect.Effect<DefaultVoice>
  readonly save: (ref: VoiceRef, reload: boolean) => Effect.Effect<DefaultVoiceSaved, ApiFailure>
}

export const makeAssistantVoice = (options: {
  readonly sections: Sections
  readonly engine: Engine
  readonly catalog: () => VoiceCatalog
  /** After a save: serve mode marks the reload pending. */
  readonly onSaved: (update: SectionUpdate) => void
}): AssistantVoice => {
  const resolved = Effect.suspend(() => Effect.provideService(assistantVoice, ConfigProvider.ConfigProvider, options.sections.configProvider()))

  const field = () => options.sections.list().find((s) => s.id === "voices")?.form.fields.find((f) => f.key === ASSISTANT_VOICE)

  const ref = Effect.map(resolved, (r) => ("problem" in r ? DEFAULT_ASSISTANT_VOICE : r.ref))

  const get: Effect.Effect<DefaultVoice> = Effect.map(resolved, (r) => {
    const f = field()
    const locked = f?.locked !== undefined
    const voice = "problem" in r ? DEFAULT_ASSISTANT_VOICE : r.ref
    const key = voiceKey(voice)
    const running = options.engine.voice()
    const name = options.catalog().nameOf(voice)
    const source = "problem" in r || r.source === "setting"
      ? (f?.source === "env-file" || f?.source === "env-process" ? "environment" as const : "saved" as const)
      : r.source
    return {
      voice,
      key,
      ...(name !== undefined ? { name } : {}),
      source,
      locked,
      ...(running !== undefined ? { running: voiceKey(running) } : {}),
      reloadPending: running !== undefined && voiceKey(running) !== key,
      notes: "problem" in r ? [r.problem] : [...r.notes]
    }
  })

  const save = (voice: VoiceRef, reload: boolean): Effect.Effect<DefaultVoiceSaved, ApiFailure> =>
    Effect.gen(function*() {
      if (field()?.locked !== undefined) {
        return yield* new ApiFailure({
          status: 409,
          code: "locked",
          message: `${ASSISTANT_VOICE} is set in the environment (.env or the service): change it there, or use Move to settings first.`
        })
      }
      yield* options.catalog().checkSelectable(voice)
      const update = yield* options.sections.update("voices", { values: { [ASSISTANT_VOICE]: voiceKey(voice) }, secrets: {} }, { confirmWarnings: true })
      if (!update.result.ok) {
        const error = update.result.error
        return yield* new ApiFailure({
          status: error.code === "invalid_settings" ? 400 : 500,
          code: error.code === "invalid_settings" ? "invalid_request" : "internal",
          message: error.message,
          ...(error.fieldErrors !== undefined
            ? { fieldErrors: error.fieldErrors.map((e) => ({ key: e.key === ASSISTANT_VOICE ? "voice" : e.key ?? "voice", message: e.message })) }
            : {})
        })
      }
      options.onSaved(update)
      let reloaded: HostResult | undefined
      if (reload) reloaded = yield* options.engine.reload
      const now = yield* get
      return {
        default: now,
        ...(reloaded === undefined
          ? {}
          : { reload: reloaded.ok ? { ok: true as const } : { ok: false as const, code: reloaded.error.code, message: reloaded.error.message } })
      }
    })

  return { ref, get, save }
}
