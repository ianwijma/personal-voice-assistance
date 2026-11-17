// Settings version 4 and the version-3 migration (docs/ASSISTANTS.md §2.5, §6, §1.2; WP-3): fixtures for the
// default install, "always" and wake-phrase kinds, device overrides, Claude subscription, environment-locked keys;
// the backup and the one write; read-only loads; per-entity `rev`; the legacy view; and a version-3 install served.
import { endOfTurn, interim, speechStarted } from "@pva/core/testing"
import {
  Assistant,
  DEFAULT_DEVICE_PROFILE,
  type DeviceProfile,
  DeviceSettings,
  effectiveProfile,
  type ProfileOverrides,
  WEB_VOICE_KIND
} from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import { Config, Effect, Logger, References, Schema } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeModuleHost } from "@pva/core"
import { cliAssistant, loadCliSettings } from "../src/cliSettings.ts"
import { defaultSystemPrompt } from "../src/config.ts"
import { makeEnvView } from "../src/envView.ts"
import { moduleCatalog } from "../src/modules.ts"
import { makeEnvCatalog, makeEnvMover } from "../src/serve/envSettings.ts"
import { makeFrontends } from "../src/serve/frontends.ts"
import { MIGRATED_ASSISTANT_ID } from "../src/serve/migrateAssistants.ts"
import { makeSections } from "../src/serve/sections.ts"
import { EntitySaveError, loadSettingsStore, type LoadOptions, type StartupStep } from "../src/serve/SettingsStore.ts"
import { assistantVoice, DEFAULT_ASSISTANT_VOICE } from "../src/voiceSelection.ts"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, type TestServer } from "./support/serveHarness.ts"
import { openStore, saveSection } from "./support/store.ts"

vi.setConfig({ testTimeout: 20_000 })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const tmp = () => mkdtempSync(join(tmpdir(), "pva-v4-"))
const isAssistant = Schema.is(Assistant)
const isDeviceSettings = Schema.is(DeviceSettings)

interface V3 {
  readonly revision?: number
  readonly modules?: Record<string, { enabled?: boolean; settings?: Record<string, unknown> }>
  readonly assistant?: Record<string, unknown>
  readonly frontends?: Record<string, ProfileOverrides>
  readonly devices?: Record<string, { kind: string; name: string; firstSeen: number; lastSeen: number; overrides: ProfileOverrides }>
}
const v3Text = (v: V3) =>
  `${JSON.stringify({ version: 3, ...(v.revision !== undefined ? { revision: v.revision } : {}), modules: v.modules ?? {}, assistant: v.assistant ?? {}, frontends: v.frontends ?? {}, devices: v.devices ?? {} }, null, 2)}\n`
/** A data directory holding a version-3 install (and its secrets file of the same revision). */
const v3Dir = (v: V3) => {
  const dir = tmp()
  writeFileSync(join(dir, "settings.json"), v3Text(v))
  if (v.revision !== undefined) {
    writeFileSync(join(dir, "secrets.json"), `${JSON.stringify({ version: 2, revision: v.revision, modules: {}, assistant: {} }, null, 2)}\n`, { mode: 0o600 })
  }
  return dir
}
const withCatalog = (env: Record<string, string | undefined> = {}): Omit<LoadOptions, "lock" | "readOnly"> => ({ assistants: { env, catalog: moduleCatalog } })
const onDisk = (dir: string, name = "settings.json") => JSON.parse(readFileSync(join(dir, name), "utf8"))

/** What the assistant of a default install is (every value the default of its flat key). */
const defaultAssistant: Assistant = {
  id: "assistant",
  rev: 0,
  name: "Assistant",
  purpose: "",
  handles: "",
  on: true,
  prompt: defaultSystemPrompt,
  toolRounds: 5,
  followUpSeconds: 8,
  newConversationAfter: 10,
  replyEarly: true,
  confirmActions: "off",
  llm: { account: "offline", model: "", effort: "low", thinking: "off", maxTokens: 1024, giveUpMs: 5000, warmUp: true, useModules: true, freshSessionAfterMinutes: 60 },
  hearing: {
    engine: "sherpa",
    model: SherpaStt.DEFAULT_PRESET,
    language: "auto",
    eagerSilenceMs: 250,
    finalSilenceMs: 600,
    minSpeechMs: 100,
    agc: true,
    agcMaxGainDb: 30,
    vadThreshold: SherpaStt.DEFAULT_VAD_THRESHOLD,
    deepgram: { eotThreshold: 0.7, eagerEotThreshold: 0.5, eotTimeoutMs: 5000 }
  },
  voice: DEFAULT_ASSISTANT_VOICE,
  modules: { clock: { on: true, offTools: [] }, weather: { on: true, offTools: [] } }
}

/** Effective profiles before the migration (version 3 rules) and after it (the legacy view of version 4). */
const profilesOf = async (dir: string, v: V3, ids: ReadonlyArray<string | undefined>) => {
  const store = await run(openStore(dir, withCatalog()))
  const f = makeFrontends({ store, enabledVoices: () => new Set(), conversationIdleMinutes: () => Number(v.assistant?.CONVERSATION_IDLE_MINUTES ?? 10) })
  const builtIn: DeviceProfile = { ...DEFAULT_DEVICE_PROFILE, conversationIdleMinutes: Number(v.assistant?.CONVERSATION_IDLE_MINUTES ?? 10) }
  return ids.map((id) => {
    const record = id === undefined ? undefined : v.devices?.[id]
    const before = effectiveProfile(v.frontends?.[WEB_VOICE_KIND] ?? {}, record?.overrides ?? {}, builtIn)
    return { id, before, after: f.profile(id), store }
  })
}

// ---------------------------------------------------------------------------------------------------------------

describe("migration fixtures", () => {
  it("default install (no settings file): one assistant from the defaults, browsers answer it always; nothing written until a save", async () => {
    const dir = tmp()
    const store = await run(openStore(dir, withCatalog()))
    const file = store.settings()
    expect(file.version).toBe(4)
    expect(file.migration).toBeUndefined()
    expect(file.assistants.order).toEqual(["assistant"])
    expect(file.assistants.byId.assistant).toEqual(defaultAssistant)
    expect(isAssistant(file.assistants.byId.assistant)).toBe(true)
    const { rev, ...web } = file.deviceTypes[WEB_VOICE_KIND]!
    expect(rev).toBe(0)
    expect(web).toEqual({
      assistants: [{ assistant: "assistant", phrases: DEFAULT_DEVICE_PROFILE.wakePhrases }],
      withoutPhrase: { mode: "assistant", assistant: "assistant" },
      matching: "close",
      voicePage: { pick: false },
      interruptMode: "confirm",
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, speakAloud: true, outputPath: "direct", prebufferMs: 60 },
      captions: { captions: true, speakTyped: true }
    })
    expect(isDeviceSettings(web)).toBe(true)
    expect(existsSync(join(dir, "settings.json"))).toBe(false)
    expect(store.problems).toEqual([])
    // The agent module (an account now) is not one of the assistant's modules.
    expect(file.assistants.byId.assistant!.modules["claude-subscription"]).toBeUndefined()
    // The legacy view: exactly today's built-in profile.
    expect(store.frontendData()).toEqual({ frontends: {}, devices: {} })
    expect(makeFrontends({ store, enabledVoices: () => new Set() }).profile(undefined)).toEqual(DEFAULT_DEVICE_PROFILE)
    // The first save writes it.
    await run(saveSection(store, "recordings", { RECORD_HEARD_AUDIO: true }, {}))
    expect(onDisk(dir)).toMatchObject({ version: 4, assistants: { order: ["assistant"] }, deviceTypes: { [WEB_VOICE_KIND]: { rev: 0 } } })
  })

  it("activation always: withoutPhrase is the assistant; wake-phrase: nobody, with the kind's phrases, matching, follow-up and reset time", async () => {
    const always = await run(openStore(v3Dir({ frontends: { [WEB_VOICE_KIND]: { activation: "always", wakePhrases: ["hey jev"] } } }), withCatalog()))
    expect(always.settings().deviceTypes[WEB_VOICE_KIND]).toMatchObject({
      assistants: [{ assistant: "assistant", phrases: ["hey jev"] }],
      withoutPhrase: { mode: "assistant", assistant: "assistant" }
    })
    expect(always.settings().migration?.notes.join(" ")).toContain("remove a wake phrase said at the start")

    const v: V3 = {
      assistant: { CONVERSATION_IDLE_MINUTES: 20 },
      frontends: { [WEB_VOICE_KIND]: { activation: "wake-phrase", wakePhrases: ["hey jeff", "computer"], wakeMatch: "exact", followUpSeconds: 3, conversationIdleMinutes: 0, interruptMode: "manual" } }
    }
    const dir = v3Dir(v)
    const [kind] = await profilesOf(dir, v, [undefined])
    const file = kind!.store.settings()
    expect(file.deviceTypes[WEB_VOICE_KIND]).toMatchObject({
      assistants: [{ assistant: "assistant", phrases: ["hey jeff", "computer"] }],
      withoutPhrase: { mode: "nobody" },
      matching: "exact",
      interruptMode: "manual"
    })
    expect(file.deviceTypes[WEB_VOICE_KIND]!.assistants[0]!.followUpSeconds).toBeUndefined()
    // Follow-up and the reset time are the assistant's now ("0 = never").
    expect(file.assistants.byId.assistant).toMatchObject({ followUpSeconds: 3, newConversationAfter: "never" })
    expect(file.migration?.notes.join(" ")).not.toContain("remove a wake phrase")
    expect(kind!.after).toEqual(kind!.before)
  })

  it("device overrides become own sections (audio and captions filled with the device's values); its voice and reset time are dropped with notes", async () => {
    const v: V3 = {
      frontends: { [WEB_VOICE_KIND]: { prebufferMs: 120, activation: "wake-phrase" } },
      devices: {
        "kitchen-01": {
          kind: WEB_VOICE_KIND,
          name: "Kitchen",
          firstSeen: 1,
          lastSeen: 2,
          overrides: {
            activation: "always",
            wakePhrases: ["hey computer"],
            followUpSeconds: 4,
            wakeMatch: "exact",
            interruptMode: "manual",
            echoCancellation: false,
            captions: false,
            conversationIdleMinutes: 3,
            voice: "sherpa:en_US-amy-medium"
          }
        },
        "bedroom-1": { kind: WEB_VOICE_KIND, name: "Bedroom", firstSeen: 3, lastSeen: 4, overrides: { followUpSeconds: 0 } },
        "hallway-1": { kind: WEB_VOICE_KIND, name: "Hallway", firstSeen: 5, lastSeen: 6, overrides: {} }
      }
    }
    const dir = v3Dir(v)
    const profiles = await profilesOf(dir, v, ["kitchen-01", "bedroom-1", "hallway-1", undefined])
    const file = profiles[0]!.store.settings()
    expect(file.devices["kitchen-01"]).toEqual({
      kind: WEB_VOICE_KIND,
      name: "Kitchen",
      firstSeen: 1,
      lastSeen: 2,
      rev: 0,
      own: {
        withoutPhrase: { mode: "assistant", assistant: "assistant" },
        assistants: [{ assistant: "assistant", phrases: ["hey computer"], followUpSeconds: 4 }],
        matching: "exact",
        interruptMode: "manual",
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, speakAloud: true, outputPath: "direct", prebufferMs: 120 },
        captions: { captions: false, speakTyped: true }
      }
    })
    // A follow-up of its own alone: the inherited phrases, with that follow-up.
    expect(file.devices["bedroom-1"]!.own).toEqual({ assistants: [{ assistant: "assistant", phrases: DEFAULT_DEVICE_PROFILE.wakePhrases, followUpSeconds: 0 }] })
    expect(file.devices["hallway-1"]!.own).toEqual({})
    const notes = file.migration!.notes.join(" ")
    expect(notes).toContain("own \"new conversation after\" setting was dropped")
    expect(notes).toContain("own voice was dropped")
    expect(notes).toContain("2 devices have own values that now cover a whole section")
    // Every device behaves as before, except the dropped voice and reset time.
    for (const p of profiles) {
      expect(p.after, p.id).toEqual({ ...p.before, voice: "", ...(p.id === "kitchen-01" ? { conversationIdleMinutes: 10 } : {}) })
    }
    // The legacy view shows the own sections as overrides.
    expect(profiles[0]!.store.frontendData().devices["bedroom-1"]!.overrides).toEqual({ followUpSeconds: 0 })
  })

  it("Claude subscription as the language model: account, model, options and the agent's own prompt move to the assistant", async () => {
    const dir = v3Dir({
      assistant: { LLM_PROVIDER: "claude-subscription", SYSTEM_PROMPT: "global prompt", ANTHROPIC_MODEL: "claude-opus-5-5" },
      modules: {
        "claude-subscription": {
          enabled: true,
          settings: { optIn: true, model: "claude-sonnet-5-5", speculate: true, tools: false, sessionIdleMinutes: 30, systemPrompt: "Be brief." }
        },
        weather: { enabled: false }
      }
    })
    const store = await run(openStore(dir, withCatalog()))
    const a = store.settings().assistants.byId.assistant!
    expect(a.llm).toMatchObject({ account: "claude-subscription", model: "claude-sonnet-5-5", useModules: false, freshSessionAfterMinutes: 30 })
    expect(a.replyEarly).toBe(true)
    expect(a.prompt).toBe("Be brief.")
    expect(a.modules).toEqual({ clock: { on: true, offTools: [] } })
    expect(store.settings().migration!.notes.join(" ")).toContain("Claude subscription agent's own system prompt")
    // Without the agent's own prompt (and with its defaults), the global prompt and no early replies.
    const plain = await run(openStore(v3Dir({ assistant: { LLM_PROVIDER: "claude-subscription", SYSTEM_PROMPT: "global prompt" } }), withCatalog()))
    expect(plain.settings().assistants.byId.assistant).toMatchObject({
      prompt: "global prompt",
      replyEarly: false,
      llm: { account: "claude-subscription", model: "claude-haiku-5-5", useModules: true, freshSessionAfterMinutes: 60 }
    })
    // The flat key and the module record stay as they were (today's engines read them).
    expect(onDisk(dir)).toMatchObject({ assistant: { LLM_PROVIDER: "claude-subscription" }, modules: { "claude-subscription": { enabled: true } } })
  })

  it("environment-set keys: migrated from the environment, then applied to and locking the migrated assistant only", async () => {
    const env: Record<string, string | undefined> = { SYSTEM_PROMPT: "from env", ANTHROPIC_MODEL: "claude-sonnet-5-5", STT_SHERPA_FINAL_SILENCE_MS: "800", LLM_PROVIDER: "anthropic" }
    const dir = v3Dir({ assistant: { SYSTEM_PROMPT: "saved prompt", LLM_PROVIDER: "fake", MAX_TOOL_ROUNDS: 2 } })
    const store = await run(openStore(dir, withCatalog(env)))
    const stored = store.settings().assistants.byId.assistant!
    // Values come from the effective settings: environment > saved > default.
    expect(stored).toMatchObject({ prompt: "from env", toolRounds: 2, llm: { account: "anthropic", model: "claude-sonnet-5-5" }, hearing: { finalSilenceMs: 800 } })
    expect(store.settings().migration!.notes.join(" ")).toContain("locked on the assistant: LLM_PROVIDER, SYSTEM_PROMPT, ANTHROPIC_MODEL, STT_SHERPA_FINAL_SILENCE_MS")
    const [inEffect] = store.assistantsInEffect()
    expect(inEffect!.locks.map((l) => l.field)).toEqual(["llm.account", "prompt", "llm.model", "hearing.finalSilenceMs"])
    // The environment is read live: a later value wins over the stored one.
    env.SYSTEM_PROMPT = "newer env"
    expect(store.assistantsInEffect()[0]!.assistant.prompt).toBe("newer env")
    expect(store.assistants()[0]!.prompt).toBe("from env")
    // A save may not change a locked field; other fields save, and the stored value of a locked one is kept.
    const refused = await run(Effect.flip(store.saveAssistantRecord({ ...stored, prompt: "typed in the page" })))
    expect(refused).toBeInstanceOf(EntitySaveError)
    expect((refused as EntitySaveError).code).toBe("locked")
    const saved = await run(store.saveAssistantRecord({ ...stored, prompt: "newer env", name: "Jeff" }))
    expect(saved).toMatchObject({ name: "Jeff", prompt: "from env", rev: 1 })
    // Another assistant is not touched by the environment.
    const other = await run(store.createAssistant({ ...stored, name: "T3", prompt: "own prompt" }))
    expect(other.id).toBe("t3")
    const t3 = store.assistantsInEffect().find((a) => a.assistant.id === "t3")!
    expect(t3).toEqual({ assistant: other, locks: [] })
    // An invalid environment value does not lock (the flat key's own check refuses it).
    env.MAX_TOOL_ROUNDS = "eleven"
    expect(store.assistantsInEffect()[0]!.locks.map((l) => l.key)).not.toContain("MAX_TOOL_ROUNDS")
  })
})

describe("the version-4 file", () => {
  it("a writable load keeps the original as settings.json.v3-backup and writes version 4 once, with the same revision", async () => {
    const v: V3 = { revision: 7, assistant: { SYSTEM_PROMPT: "x" }, frontends: { [WEB_VOICE_KIND]: { interruptMode: "instant" } } }
    const dir = v3Dir(v)
    const steps: Array<StartupStep> = []
    const store = await run(openStore(dir, { ...withCatalog(), beforeStartupStep: (s) => void steps.push(s), now: () => 1_794_931_200_000 }))
    expect(steps).toEqual(["migrate-assistants"])
    expect(readFileSync(join(dir, "settings.json.v3-backup"), "utf8")).toBe(v3Text(v))
    const written = onDisk(dir)
    expect(written).toMatchObject({ version: 4, revision: 7, assistant: { SYSTEM_PROMPT: "x" }, migration: { from: 3, at: 1_794_931_200_000 } })
    expect(written).toEqual(JSON.parse(JSON.stringify(store.settings())))
    expect(store.blocked()).toBeUndefined()
    expect(store.problems.join(" ")).toContain("was migrated to version 4")
    // The next start reads version 4 as it is: no second migration, no new notes.
    const again: Array<StartupStep> = []
    const restarted = await run(openStore(dir, { ...withCatalog(), beforeStartupStep: (s) => void again.push(s) }))
    expect(again).toEqual([])
    expect(restarted.problems).toEqual([])
    expect(restarted.settings()).toEqual(store.settings())
    expect(readdirSync(dir).filter((n) => n.includes("backup"))).toEqual(["settings.json.v3-backup"])
  })

  it("an existing backup holding something else is not overwritten", async () => {
    const dir = v3Dir({ assistant: { A: 1 } })
    writeFileSync(join(dir, "settings.json.v3-backup"), "an older original")
    await run(openStore(dir, withCatalog()))
    expect(readFileSync(join(dir, "settings.json.v3-backup"), "utf8")).toBe("an older original")
    expect(readdirSync(dir).filter((n) => n.startsWith("settings.json.v3-backup-"))).toHaveLength(1)
  })

  it("a read-only load migrates in memory only, and sees one committed state while the server migrates", async () => {
    const v: V3 = { revision: 3, assistant: { ANTHROPIC_MODEL: "claude-opus-5-5", LLM_PROVIDER: "anthropic" } }
    const dir = v3Dir(v)
    const reader = await run(loadSettingsStore(dir, { readOnly: true, assistants: { catalog: moduleCatalog } }))
    expect(reader.settings()).toMatchObject({ version: 4, revision: 3, assistants: { byId: { assistant: { llm: { model: "claude-opus-5-5" } } } } })
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(v3Text(v))
    expect(existsSync(join(dir, "settings.json.v3-backup"))).toBe(false)
    // A reader during the server's migration (paused before its write) and after it: the same assistant, from one save.
    let release!: () => void
    let paused!: () => void
    const atStep = new Promise<void>((r) => (paused = r))
    const writer = run(openStore(dir, {
      ...withCatalog(),
      beforeStartupStep: (s) => (s === "migrate-assistants" ? (paused(), new Promise<void>((r) => (release = r))) : undefined)
    }))
    await atStep
    const during = await run(loadSettingsStore(dir, { readOnly: true, assistants: { catalog: moduleCatalog } }))
    release()
    await writer
    const after = await run(loadSettingsStore(dir, { readOnly: true, assistants: { catalog: moduleCatalog } }))
    expect(onDisk(dir).version).toBe(4)
    for (const r of [during, after]) {
      expect(r.blocked()).toBeUndefined()
      expect(r.settings().revision).toBe(3)
      expect(r.assistants()).toEqual(reader.assistants())
      expect(r.settings().deviceTypes).toEqual(reader.settings().deviceTypes)
    }
    // The CLI answers as the first switched-on assistant (migrated in memory, the environment applied).
    const cli = await run(loadCliSettings({ env: { ANTHROPIC_MODEL: "claude-haiku-5-5" }, dataDir: dir, vaultPath: join(dir, "vault", "none.enc"), catalog: moduleCatalog }))
    expect(cli.settings.assistant).toMatchObject({ id: "assistant", llm: { account: "anthropic", model: "claude-haiku-5-5" } })
    expect(cliAssistant(cli.settings.store!, "nobody-here")?.id).toBe("assistant")
  })

  it("entities are saved with their rev: a stale save is refused; delete removes the assistant from every list", async () => {
    const dir = v3Dir({ devices: { "kitchen-01": { kind: WEB_VOICE_KIND, name: "Kitchen", firstSeen: 1, lastSeen: 2, overrides: { activation: "wake-phrase" } } } })
    const store = await run(openStore(dir, withCatalog()))
    const a = store.assistants()[0]!
    const once = await run(store.saveAssistantRecord({ ...a, purpose: "Everything" }))
    expect(once.rev).toBe(1)
    const stale = await run(Effect.flip(store.saveAssistantRecord({ ...a, purpose: "From another tab" })))
    expect(stale).toMatchObject({ _tag: "EntitySaveError", code: "stale" })
    expect(store.assistants()[0]!.purpose).toBe("Everything")
    expect(await run(Effect.flip(store.saveAssistantRecord({ ...a, id: "nobody", rev: 0 })))).toMatchObject({ code: "unknown_assistant" })

    const keuken = await run(store.createAssistant({ ...a, name: "Keuken" }))
    expect(keuken).toMatchObject({ id: "keuken", rev: 0 })
    const web = store.settings().deviceTypes[WEB_VOICE_KIND]!
    const { rev: _, ...webSettings } = web
    const typeSaved = await run(store.saveDeviceType(WEB_VOICE_KIND, 0, {
      ...webSettings,
      assistants: [...webSettings.assistants, { assistant: "keuken", phrases: ["hey keuken"] }],
      withoutPhrase: { mode: "typesafe", fallback: "keuken", giveUpMs: 400 }
    }))
    expect(typeSaved.rev).toBe(1)
    expect(await run(Effect.flip(store.saveDeviceType(WEB_VOICE_KIND, 0, webSettings)))).toMatchObject({ code: "stale" })
    expect(await run(Effect.flip(store.saveDeviceType("toaster", 0, webSettings)))).toMatchObject({ code: "unknown_device" })
    const device = store.settings().devices["kitchen-01"]!
    const own = { ...device.own, assistants: [{ assistant: "keuken", phrases: ["keuken"] }] }
    expect((await run(store.saveDevice("kitchen-01", 0, { name: " Kitchen 2 ", own }))).rev).toBe(1)
    expect(await run(Effect.flip(store.saveDevice("kitchen-01", 0, { own: {} })))).toMatchObject({ code: "stale" })

    expect(await run(Effect.flip(store.deleteAssistantRecord("keuken", 5)))).toMatchObject({ code: "stale" })
    await run(store.deleteAssistantRecord("keuken", 0))
    const file = store.settings()
    expect(file.assistants.order).toEqual(["assistant"])
    expect(file.deviceTypes[WEB_VOICE_KIND]).toMatchObject({ rev: 2, withoutPhrase: { mode: "typesafe", fallback: "assistant" } })
    expect(file.deviceTypes[WEB_VOICE_KIND]!.assistants.map((x) => x.assistant)).toEqual(["assistant"])
    expect(file.devices["kitchen-01"]).toMatchObject({ name: "Kitchen 2", rev: 2, own: { assistants: [] } })
    // Revs survive a restart.
    const restarted = await run(openStore(dir, withCatalog()))
    expect(restarted.assistants()[0]!.rev).toBe(1)
    expect(restarted.settings().deviceTypes[WEB_VOICE_KIND]!.rev).toBe(2)
    expect(await run(Effect.flip(restarted.saveAssistantRecord({ ...a, rev: 0 })))).toMatchObject({ code: "stale" })
    // At most 16 assistants.
    for (let i = 0; i < 15; i++) await run(restarted.createAssistant({ ...a, name: `A${i}` }))
    expect(await run(Effect.flip(restarted.createAssistant({ ...a, name: "One too many" })))).toMatchObject({ code: "limit_reached" })
  })

  it("a type without stored defaults (missing or dropped) is rev 0; the first record any save makes is rev 1", async () => {
    const dir = v3Dir({})
    const first = await run(openStore(dir, withCatalog()))
    await run(saveSection(first, "recordings", { RECORD_HEARD_AUDIO: true }, {}))
    const { rev: _, ...webSettings } = first.settings().deviceTypes[WEB_VOICE_KIND]!
    const rewrite = (deviceType: unknown) => {
      const file = onDisk(dir)
      if (deviceType === undefined) delete file.deviceTypes[WEB_VOICE_KIND]
      else file.deviceTypes[WEB_VOICE_KIND] = deviceType
      writeFileSync(join(dir, "settings.json"), `${JSON.stringify(file, null, 2)}\n`)
    }

    // Missing: `device.save`'s path.
    rewrite(undefined)
    const missing = await run(openStore(dir, withCatalog()))
    expect(missing.settings().deviceTypes[WEB_VOICE_KIND]).toBeUndefined()
    expect((await run(missing.saveDeviceType(WEB_VOICE_KIND, 0, { ...webSettings, matching: "exact" }))).rev).toBe(1)
    expect(await run(Effect.flip(missing.saveDeviceType(WEB_VOICE_KIND, 0, webSettings)))).toMatchObject({ code: "stale" })
    expect((await run(missing.saveDeviceType(WEB_VOICE_KIND, 1, webSettings))).rev).toBe(2)

    // Not valid, so dropped at load (its old rev is gone with it): the same.
    rewrite({ ...webSettings, matching: "sideways", rev: 7 })
    const dropped = await run(openStore(dir, withCatalog()))
    expect(dropped.problems.some((p) => p.includes("were not valid and were dropped"))).toBe(true)
    expect(dropped.settings().deviceTypes[WEB_VOICE_KIND]).toBeUndefined()
    expect((await run(dropped.saveDeviceType(WEB_VOICE_KIND, 0, webSettings))).rev).toBe(1)

    // Missing, then changed through the legacy view (`frontend.update`): also rev 1.
    rewrite(undefined)
    const legacy = await run(openStore(dir, withCatalog()))
    await run(legacy.saveFrontends("kind defaults", (d) => ({ ...d, frontends: { [WEB_VOICE_KIND]: { captions: false } } })))
    expect(legacy.settings().deviceTypes[WEB_VOICE_KIND]).toMatchObject({ rev: 1, captions: { captions: false } })
  })
})

describe("today's pages on version 4", () => {
  it("front-end saves are written into the type defaults, the devices and the migrated assistant; lastSeen alone keeps the rev", async () => {
    let now = 1_000_000
    const dir = v3Dir({})
    const store = await run(openStore(dir, withCatalog()))
    const f = makeFrontends({ store, enabledVoices: () => new Set(), now: () => now })
    expect((await run(f.updateKind(WEB_VOICE_KIND, { followUpSeconds: 5, conversationIdleMinutes: 0, activation: "wake-phrase", prebufferMs: 200 }))).ok).toBe(true)
    let file = store.settings()
    expect(file.assistants.byId.assistant).toMatchObject({ followUpSeconds: 5, newConversationAfter: "never", rev: 1 })
    expect(file.deviceTypes[WEB_VOICE_KIND]).toMatchObject({ withoutPhrase: { mode: "nobody" }, audio: { prebufferMs: 200, speakAloud: true }, rev: 1 })
    expect(f.kinds()[0]!.defaults).toEqual({ followUpSeconds: 5, conversationIdleMinutes: 0, activation: "wake-phrase", prebufferMs: 200 })

    await run(f.seen({ id: "phone-0001", kind: WEB_VOICE_KIND, name: "Phone" }, new Set()))
    expect((await run(f.updateDevice("phone-0001", undefined, { wakePhrases: ["hey phone"], autoGainControl: false }))).ok).toBe(true)
    file = store.settings()
    expect(file.devices["phone-0001"]).toMatchObject({
      rev: 1,
      own: {
        assistants: [{ assistant: "assistant", phrases: ["hey phone"] }],
        audio: { autoGainControl: false, prebufferMs: 200, echoCancellation: true }
      }
    })
    expect(f.profile("phone-0001")).toMatchObject({ wakePhrases: ["hey phone"], autoGainControl: false, prebufferMs: 200, followUpSeconds: 5, activation: "wake-phrase" })
    now += 20 * 60_000
    await run(f.seen({ id: "phone-0001", kind: WEB_VOICE_KIND, name: "Phone" }, new Set()))
    expect(store.settings().devices["phone-0001"]).toMatchObject({ rev: 1, lastSeen: now })
    // Resetting the overrides returns the sections to the type defaults.
    expect((await run(f.updateDevice("phone-0001", "Phone 2", { wakePhrases: null, autoGainControl: null }))).ok).toBe(true)
    expect(store.settings().devices["phone-0001"]).toMatchObject({ name: "Phone 2", own: {}, rev: 2 })
    // What the legacy view cannot show (a second assignment) survives a save through it.
    const { rev, ...web } = store.settings().deviceTypes[WEB_VOICE_KIND]!
    const other = await run(store.createAssistant({ ...store.assistants()[0]!, name: "T3" }))
    await run(store.saveDeviceType(WEB_VOICE_KIND, rev, { ...web, assistants: [...web.assistants, { assistant: other.id, phrases: ["hey t3"] }] }))
    expect((await run(f.updateKind(WEB_VOICE_KIND, { captions: false }))).ok).toBe(true)
    expect(store.settings().deviceTypes[WEB_VOICE_KIND]!.assistants.map((a) => a.assistant)).toEqual(["assistant", "t3"])
  })

  it("flat keys that became per assistant and module switches are mirrored into the migrated assistant", async () => {
    const store = await run(openStore(tmp(), withCatalog()))
    await run(saveSection(store, "llm-behaviour", { SYSTEM_PROMPT: "Talk like a pirate.", MAX_TOOL_ROUNDS: 3 }, {}))
    await run(saveSection(store, "language-model", { LLM_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-sonnet-5-5", ANTHROPIC_THINKING: "adaptive" }, {}))
    await run(store.saveModule("weather", { enabled: false, settings: {}, secrets: {} }))
    const a = store.assistants()[0]!
    expect(a).toMatchObject({ prompt: "Talk like a pirate.", toolRounds: 3, llm: { account: "anthropic", model: "claude-sonnet-5-5", thinking: "adaptive" }, rev: 3 })
    expect(a.modules).toEqual({ clock: { on: true, offTools: [] }, weather: { on: false, offTools: [] } })
    // Back to the defaults: the section saved without the keys.
    await run(saveSection(store, "llm-behaviour", {}, {}))
    expect(store.assistants()[0]).toMatchObject({ prompt: defaultSystemPrompt, toolRounds: 5, newConversationAfter: 10 })
    // An agent module's switch is an account, not a module choice.
    await run(store.saveModule("claude-subscription", { enabled: true, settings: {}, secrets: {} }))
    expect(store.assistants()[0]!.modules["claude-subscription"]).toBeUndefined()
  })

  it("the Claude subscription agent's per-assistant settings changed after migration are mirrored into the migrated assistant (WP-13a)", async () => {
    const store = await run(openStore(tmp(), withCatalog({ LLM_PROVIDER: "claude-subscription" })))
    const before = store.assistants()[0]!
    expect(before.llm).toMatchObject({ account: "claude-subscription", model: "claude-haiku-5-5", useModules: true, freshSessionAfterMinutes: 60 })
    expect(before.replyEarly).toBe(false)
    await run(store.saveModule("claude-subscription", {
      enabled: true,
      settings: { optIn: true, model: "claude-sonnet-5-5", tools: false, sessionIdleMinutes: 30, speculate: true, systemPrompt: "Be brief." },
      secrets: {}
    }))
    expect(store.assistants()[0]).toMatchObject({
      prompt: "Be brief.",
      replyEarly: true,
      llm: { account: "claude-subscription", model: "claude-sonnet-5-5", useModules: false, freshSessionAfterMinutes: 30 },
      rev: before.rev + 1
    })
    // Only what the save changed: the assistant's own later edit of its model is kept when the module's model is not
    // touched (a shared setting saved: the program).
    await run(store.saveAssistantRecord({ ...store.assistants()[0]!, llm: { ...store.assistants()[0]!.llm, model: "claude-opus-5-5" } }))
    await run(store.saveModule("claude-subscription", {
      enabled: true,
      settings: { optIn: true, model: "claude-sonnet-5-5", tools: false, sessionIdleMinutes: 30, speculate: true, systemPrompt: "Be brief.", claudePath: "/opt/claude" },
      secrets: {}
    }))
    expect(store.assistants()[0]!.llm.model).toBe("claude-opus-5-5")

    // The environment's CLAUDE_SUBSCRIPTION_MODEL locks the model; an assistant on another account is not touched.
    const locked = await run(openStore(tmp(), withCatalog({ LLM_PROVIDER: "claude-subscription", CLAUDE_SUBSCRIPTION_MODEL: "claude-haiku-5-5" })))
    await run(locked.saveModule("claude-subscription", { enabled: true, settings: { model: "claude-sonnet-5-5", tools: false }, secrets: {} }))
    expect(locked.assistants()[0]!.llm).toMatchObject({ model: "claude-haiku-5-5", useModules: false })
    const other = await run(openStore(tmp(), withCatalog({ LLM_PROVIDER: "anthropic" })))
    const otherBefore = other.assistants()[0]!
    await run(other.saveModule("claude-subscription", { enabled: true, settings: { model: "claude-sonnet-5-5", tools: false }, secrets: {} }))
    expect(other.assistants()[0]).toEqual(otherBefore)
  })

  it("Move to settings: a per-assistant key is an assistant-field target; moving it writes the migrated assistant and unlocks it", async () => {
    expect(makeEnvCatalog(moduleCatalog).target("SYSTEM_PROMPT")).toMatchObject({ kind: "assistant-field", assistantId: MIGRATED_ASSISTANT_ID, field: "prompt" })
    expect(makeEnvCatalog(moduleCatalog).target("ANTHROPIC_API_KEY")?.kind).toBe("section")
    const dir = tmp()
    const envPath = join(dir, ".env")
    const envText = "SYSTEM_PROMPT=Moved prompt\nSTT_SHERPA_EAGER_SILENCE_MS=300\n"
    writeFileSync(envPath, envText)
    const view = makeEnvView({ processEnv: {}, files: [{ path: envPath, text: envText }] })
    mkdirSync(join(dir, "data"))
    const store = await run(openStore(join(dir, "data"), { assistants: { env: view.record, catalog: [greeterModule] } }))
    expect(store.assistantsInEffect()[0]!.locks.map((l) => l.key)).toEqual(["SYSTEM_PROMPT", "STT_SHERPA_EAGER_SILENCE_MS"])
    const sections = makeSections(store, view.record, { envOrigin: view.sourceOf, envLocation: view.locationOf })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [greeterModule], persistence: store.modulePersistence, env: view.record })
      const mover = makeEnvMover({ view, catalog: [greeterModule], sections, host, store, vaultState: () => "none", onMoved: () => {} })
      expect(yield* mover.move(["SYSTEM_PROMPT", "STT_SHERPA_EAGER_SILENCE_MS"])).toMatchObject({ ok: true })
    })).pipe(Effect.provideService(References.MinimumLogLevel, "Error"), Effect.provide(Logger.layer([]))))
    expect(store.assistantsInEffect()[0]!.locks).toEqual([])
    expect(store.assistants()[0]).toMatchObject({ prompt: "Moved prompt", hearing: { eagerSilenceMs: 300 } })
    expect(store.settings().assistant).toMatchObject({ SYSTEM_PROMPT: "Moved prompt", STT_SHERPA_EAGER_SILENCE_MS: 300 })
    expect(readFileSync(envPath, "utf8")).toContain("# SYSTEM_PROMPT moved to the settings UI")
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe("serve: a version-3 install starts on version 4", () => {
  let server: TestServer | undefined
  const clients: Array<ScriptedClient> = []
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close()
    await server?.close()
    server = undefined
  })

  it("its first turn uses the same providers, prompt, phrases and interrupting as before, and the assistant holds them", async () => {
    const dataDir = v3Dir({
      revision: 4,
      assistant: {
        LLM_PROVIDER: "anthropic",
        ANTHROPIC_MODEL: "claude-sonnet-5-5",
        STT_PROVIDER: "deepgram",
        ASSISTANT_VOICE: "sherpa:en_US-amy-medium",
        SYSTEM_PROMPT: "Answer like a butler."
      },
      frontends: { [WEB_VOICE_KIND]: { interruptMode: "instant", activation: "wake-phrase", wakePhrases: ["hey jeff"] } }
    })
    const stt = controlledStt()
    const llm = scriptedLlm((t) => `Certainly: ${t}`)
    const built: Array<Record<string, string>> = []
    const base = fakeBuild({ stt: stt.stt, llm: llm.llm })
    // What the engine build reads: the same ConfigProvider the real builder reads (environment > saved settings).
    const build = Effect.gen(function*() {
      const read = (key: string) => Effect.gen(function*() {
        return yield* Config.String(key).pipe(Config.withDefault(""))
      }).pipe(Effect.orElseSucceed(() => ""))
      const voice = yield* assistantVoice
      built.push({
        LLM_PROVIDER: yield* read("LLM_PROVIDER"),
        ANTHROPIC_MODEL: yield* read("ANTHROPIC_MODEL"),
        STT_PROVIDER: yield* read("STT_PROVIDER"),
        voice: "ref" in voice ? `${voice.ref.provider}:${voice.ref.voiceId}` : "problem"
      })
      return yield* base
    })
    server = await startTestServer({ dataDir, build })
    const client = await ScriptedClient.connect({ url: server.url })
    clients.push(client)
    const welcome = await client.hello()
    expect(welcome.snapshot.device?.profile).toMatchObject({ activation: "wake-phrase", wakePhrases: ["hey jeff"], interruptMode: "instant" })
    await client.claim()
    await client.waitFor("state", (m) => m.state === "asleep", { from: 0 })
    stt.emit(speechStarted, interim("Hey Jeff, what"), endOfTurn("Hey Jeff, what time is it?"))
    expect((await client.waitFor("turn.start", () => true, { from: 0 })).userText).toBe("what time is it?")
    await client.waitFor("turn.end", () => true, { from: 0, timeoutMs: 10_000 })
    expect(built[0]).toEqual({ LLM_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-sonnet-5-5", STT_PROVIDER: "deepgram", voice: "sherpa:en_US-amy-medium" })
    expect(llm.requests[0]!.system).toContain("Answer like a butler.")

    // The version-4 file: the assistant holds exactly what the engines were built from.
    const file = onDisk(dataDir)
    expect(file).toMatchObject({ version: 4, migration: { from: 3 } })
    expect(file.revision).toBeGreaterThanOrEqual(4) // the device's hello saved since
    expect(file.assistants.byId.assistant).toMatchObject({
      prompt: "Answer like a butler.",
      llm: { account: "anthropic", model: "claude-sonnet-5-5" },
      hearing: { engine: "deepgram" },
      voice: { provider: "sherpa", voiceId: "en_US-amy-medium" }
    })
    expect(file.deviceTypes[WEB_VOICE_KIND]).toMatchObject({
      assistants: [{ assistant: "assistant", phrases: ["hey jeff"] }],
      withoutPhrase: { mode: "nobody" },
      interruptMode: "instant"
    })
    expect(readFileSync(join(dataDir, "settings.json.v3-backup"), "utf8")).toContain('"version": 3')
  })
})
