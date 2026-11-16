import { type VoiceRef, voiceKey } from "@pva/core"
import type { Assistant, DefaultVoice } from "@pva/protocol"
import { Effect } from "effect"
import { DEFAULT_ASSISTANT_VOICE } from "../voiceSelection.ts"
import type { VoiceCatalog } from "./VoiceCatalog.ts"

/**
 * The voices of the assistants as the voice API reads them (docs/ASSISTANTS.md §5.5, WP-10). Each assistant has its
 * own `voice`, saved with the assistant (`assistant.save`, the Voice tab); `GET /api/voices/default` answers with
 * the first assistant's, and `PUT /api/voices/default` is gone (410).
 */

export interface AssistantVoice {
  /** The first assistant's voice (a switched-on one if there is one): `GET /api/voices`' `selected`. */
  readonly ref: Effect.Effect<VoiceRef>
  /** Voice key → the assistants that speak with it (every assistant, switched on or not). */
  readonly usedBy: () => ReadonlyMap<string, ReadonlyArray<string>>
  /** `GET /api/voices/default`. */
  readonly get: Effect.Effect<DefaultVoice>
}

export const makeAssistantVoice = (options: {
  readonly assistants: () => ReadonlyArray<Assistant>
  readonly catalog: () => VoiceCatalog
  /** The key of a voice the pool has running now. */
  readonly isRunning: (key: string) => boolean
}): AssistantVoice => {
  const first = (): Assistant | undefined => {
    const all = options.assistants()
    return all.find((a) => a.on) ?? all[0]
  }
  const refNow = (): VoiceRef => first()?.voice ?? DEFAULT_ASSISTANT_VOICE

  const usedBy = (): ReadonlyMap<string, ReadonlyArray<string>> => {
    const used = new Map<string, Array<string>>()
    for (const a of options.assistants()) {
      const key = voiceKey(a.voice)
      used.set(key, [...(used.get(key) ?? []), a.id])
    }
    return used
  }

  const get: Effect.Effect<DefaultVoice> = Effect.sync(() => {
    const assistant = first()
    const voice = refNow()
    const key = voiceKey(voice)
    const name = options.catalog().nameOf(voice)
    return {
      voice,
      key,
      ...(name !== undefined ? { name } : {}),
      source: assistant === undefined ? "default" as const : "assistant" as const,
      locked: false,
      ...(options.isRunning(key) ? { running: key } : {}),
      reloadPending: false,
      notes: assistant === undefined ? ["No assistant is set up."] : [`This is ${assistant.name}'s voice; each assistant has its own, in its Voice tab.`]
    }
  })

  return { ref: Effect.sync(refNow), usedBy, get }
}
