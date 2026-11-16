// The voices of the assistants as the voice API reads them (docs/ASSISTANTS.md §5.5): `GET /api/voices/default` answers
// with the first assistant's voice, `usedBy` maps every voice to the assistants that speak with it.
import { type VoiceRef, voiceKey } from "@pva/core"
import type { Assistant } from "@pva/protocol"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeAssistantVoice } from "../src/serve/AssistantVoice.ts"
import type { VoiceCatalog } from "../src/serve/VoiceCatalog.ts"
import { DEFAULT_ASSISTANT_VOICE } from "../src/voiceSelection.ts"

const PIPER: VoiceRef = { provider: "sherpa", voiceId: "en_US-lessac-medium" }
const HEART: VoiceRef = { provider: "sherpa", voiceId: "kokoro-af_heart" }
const SARAH: VoiceRef = { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL" }

/** Only the fields `makeAssistantVoice` reads. */
const assistant = (id: string, voice: VoiceRef, on = true): Assistant => ({ id, name: id.toUpperCase(), on, voice }) as unknown as Assistant

const catalog = (names: Record<string, string> = {}): VoiceCatalog => ({ nameOf: (ref: VoiceRef) => names[voiceKey(ref)] }) as unknown as VoiceCatalog

const make = (assistants: ReadonlyArray<Assistant>, options: { names?: Record<string, string>; running?: ReadonlyArray<string> } = {}) =>
  makeAssistantVoice({
    assistants: () => assistants,
    catalog: () => catalog(options.names),
    isRunning: (key) => (options.running ?? []).includes(key)
  })

describe("AssistantVoice", () => {
  it("the first assistant's voice is the one that is switched on, else the first of all", async () => {
    const mixed = make([assistant("alpha", PIPER, false), assistant("bravo", HEART), assistant("charlie", SARAH)])
    expect(await Effect.runPromise(mixed.ref)).toEqual(HEART)
    const allOff = make([assistant("alpha", PIPER, false), assistant("bravo", HEART, false)])
    expect(await Effect.runPromise(allOff.ref)).toEqual(PIPER)
  })

  it("without an assistant it is the built-in default voice, and says no assistant is set up", async () => {
    const none = make([])
    expect(await Effect.runPromise(none.ref)).toEqual(DEFAULT_ASSISTANT_VOICE)
    const answer = await Effect.runPromise(none.get)
    expect(answer).toMatchObject({ voice: DEFAULT_ASSISTANT_VOICE, key: voiceKey(DEFAULT_ASSISTANT_VOICE), source: "default", locked: false, reloadPending: false })
    expect(answer.notes).toEqual(["No assistant is set up."])
  })

  it("reads the assistants again on every call: a voice saved with the assistant shows at once", async () => {
    let list = [assistant("alpha", PIPER)]
    const voice = makeAssistantVoice({ assistants: () => list, catalog: () => catalog(), isRunning: () => false })
    expect((await Effect.runPromise(voice.get)).key).toBe(voiceKey(PIPER))
    list = [assistant("alpha", HEART)]
    expect((await Effect.runPromise(voice.get)).key).toBe(voiceKey(HEART))
    expect([...voice.usedBy().keys()]).toEqual([voiceKey(HEART)])
  })

  it("`get` names the assistant, the catalog's name of the voice, and whether the pool runs it", async () => {
    const key = voiceKey(HEART)
    const running = await Effect.runPromise(make([assistant("alpha", HEART)], { names: { [key]: "Heart" }, running: [key] }).get)
    expect(running).toMatchObject({ voice: HEART, key, name: "Heart", source: "assistant", running: key })
    expect(running.notes[0]).toContain("ALPHA")

    const idle = await Effect.runPromise(make([assistant("alpha", HEART)]).get)
    expect(idle.name).toBeUndefined()
    expect(idle).not.toHaveProperty("running")
    expect(idle).not.toHaveProperty("name")
  })

  it("`usedBy` groups every assistant by voice, switched on or not, in the order of the list", () => {
    const used = make([assistant("alpha", PIPER), assistant("bravo", HEART, false), assistant("charlie", PIPER), assistant("delta", SARAH)]).usedBy()
    expect(Object.fromEntries(used)).toEqual({
      [voiceKey(PIPER)]: ["alpha", "charlie"],
      [voiceKey(HEART)]: ["bravo"],
      [voiceKey(SARAH)]: ["delta"]
    })
  })

  it("`usedBy` is empty without assistants", () => {
    expect(make([]).usedBy().size).toBe(0)
  })
})
