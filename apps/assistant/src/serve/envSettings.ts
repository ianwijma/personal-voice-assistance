import type { ModuleDefinition, ModuleHost, Setting, SettingsSpec } from "@pva/core"
import type { HostResult } from "@pva/core"
import { RISK_POLICY_KEYS } from "@pva/protocol"
import type { EnvEntry, EnvInfo, EnvKind, SettingsGroup, SettingsPatch, SettingValue } from "@pva/protocol"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { type CommentOutResult, commentOutKeys, type EnvOrigin, type EnvView } from "../envView.ts"
import { assistantFieldOf, MIGRATED_ASSISTANT_ID } from "./migrateAssistants.ts"
import type { Sections } from "./sections.ts"
import { sectionDefinitions } from "./sectionDefinitions.ts"
import type { SettingsStore } from "./SettingsStore.ts"
import { MEMBERS_ENV_REFUSED, MEMBERS_KEY } from "./people.ts"

/**
 * Settings set outside the UI (docs/SETTINGS-UI.md §4.4): which environment
 * variables the assistant knows, what kind each is, and "Move to settings".
 *
 * Kinds: `bootstrap` (read before the UI exists; stays in `.env`), `development`
 * (benchmarks, tests, the command-line audio), `setting` (a field of a section
 * or module, or an engine setting without a field yet) and `unknown` (nothing
 * reads it). Only `setting` variables from a `.env` file can be moved.
 *
 * A key that became a field of the assistant (docs/ASSISTANTS.md §4.4: SYSTEM_PROMPT, ANTHROPIC_MODEL, STT_*, …) is
 * an `assistant-field` target: its value applies to, and locks, that field of the migrated assistant only, and
 * "Move to settings" writes it there (through its flat key, which today's engines still read and which the store
 * mirrors into the assistant) before the line is commented out.
 */

/** Read before the settings exist, or deciding who may reach the page: they stay in `.env`. */
export const BOOTSTRAP_KEYS: ReadonlySet<string> = new Set([
  "PVA_VAULT_PASSWORD",
  "PVA_ADMIN_PASSWORD",
  "PVA_DATA_DIR",
  "PVA_VAULT_PATH",
  "SERVE_HOST",
  "SERVE_PORT",
  "SERVE_TLS_CERT",
  "SERVE_TLS_KEY",
  "SERVE_BEHIND_PROXY"
])

/** Benchmarks, tests and the command-line modes' audio (docs/SETTINGS-UI.md §1). */
const DEVELOPMENT_KEYS: ReadonlySet<string> = new Set([
  "SERVE_ALLOWED_ORIGINS",
  "PVA_WEB_DIR",
  "AUDIO_BACKEND",
  "AUDIO_INPUT_FILE",
  "AUDIO_INPUT_TRAILING_SILENCE_MS",
  "AUDIO_OUTPUT_DIR",
  "BARGE_IN",
  "DEEPGRAM_URL",
  "CARTESIA_URL",
  "CARTESIA_SAMPLE_RATE",
  "ELEVENLABS_URL",
  "ELEVENLABS_SAMPLE_RATE",
  "NEXT_PUBLIC_PVA_WS_URL",
  "SCREENSHOT_DIR",
  "RUNS",
  "CLAUDE_SUBSCRIPTION_LIVE"
])
const DEVELOPMENT_PREFIXES = ["BENCH_", "PIPEWIRE_", "MOCK_", "E2E_"]

/**
 * Engine settings the providers read that have no field yet: they can still move out of `.env` (saved by key; the
 * providers read them from the saved settings like any other). Each names the page it belongs to.
 */
const ENGINE_KEYS: Readonly<Record<string, string>> = {
  STT_SHERPA_THREADS: "speech/engine",
  STT_SHERPA_MODEL_DIR: "speech/engine",
  DEEPGRAM_MODEL: "speech/deepgram",
  DEEPGRAM_EOT_TIMEOUT_MS: "speech/deepgram",
  // Read only to migrate to ASSISTANT_VOICE (docs/VOICE-PROVIDERS.md §6.2); no field any more.
  TTS_PROVIDER: "voices/providers",
  DEFAULT_VOICE: "voices/overview",
  VOICES: "voices/overview",
  TTS_SHERPA_PRESET: "voices/providers",
  TTS_SHERPA_MODEL_DIR: "voices/providers",
  TTS_SHERPA_THREADS: "voices/providers",
  TTS_SHERPA_SPEED: "voices/providers",
  TTS_SHERPA_TRIM_SILENCE: "voices/providers",
  TTS_SHERPA_CLAUSE_PAUSE_MS: "voices/providers",
  TTS_SHERPA_SENTENCE_PAUSE_MS: "voices/providers",
  TTS_SHERPA_PAD_MS: "voices/providers",
  TTS_SHERPA_CHUNK_MS: "voices/providers",
  CARTESIA_MODEL: "voices/providers",
  CARTESIA_VOICE: "voices/providers",
  CARTESIA_LANGUAGE: "voices/providers",
  CARTESIA_MAX_BUFFER_DELAY_MS: "voices/providers",
  ELEVENLABS_MODEL: "voices/providers",
  ELEVENLABS_VOICE: "voices/providers",
  ELEVENLABS_LANGUAGE: "voices/providers",
  ELEVENLABS_SPEED: "voices/providers",
  ELEVENLABS_STABILITY: "voices/providers",
  ELEVENLABS_AUTO_MODE: "voices/providers"
}
/** `VOICE_<NAME>_<KEY>`: a per-voice override of an engine key (or `VOICE_<NAME>_PROVIDER`). */
const VOICE_KEY = /^VOICE_[A-Z0-9]+_(.+)$/

/**
 * Variables the assistant knows and refuses to read, with why (shown in the environment view; protocol 11
 * `EnvEntry.refused`). `HOUSEHOLD_MEMBERS`: people have ids the server makes.
 */
export const REFUSED_KEYS: Readonly<Record<string, string>> = { [MEMBERS_KEY]: MEMBERS_ENV_REFUSED }

const isSecretName = (key: string) => /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(key)

/** The settings category slug of the web UI for a server group (`lib/settingsTree.ts` `settingsGroups`). */
const groupSlug: Readonly<Record<SettingsGroup, string>> = {
  agents: "language-model",
  speech: "speech",
  voices: "voices",
  modules: "modules",
  access: "keys",
  diagnostics: "diagnostics",
  general: "other"
}
const groupTitle: Readonly<Record<string, string>> = {
  "language-model": "Language model",
  speech: "Speech recognition",
  voices: "Voices",
  modules: "Modules",
  keys: "Keys & access",
  diagnostics: "Diagnostics",
  other: "Other"
}

/** Where a known variable lands. */
export type EnvTarget =
  | { readonly kind: "section"; readonly key: string; readonly setting: Setting<unknown>; readonly path: ReadonlyArray<string>; readonly title: string }
  | {
    readonly kind: "assistant-field"
    /** The assistant whose field it sets and locks: the migrated one. */
    readonly assistantId: string
    /** The field (a dotted path of `Assistant`). */
    readonly field: string
    /** Its flat key (the section field the settings screen still shows). */
    readonly key: string
    readonly setting: Setting<unknown>
    readonly path: ReadonlyArray<string>
    readonly title: string
  }
  | {
    readonly kind: "module"
    readonly moduleId: string
    readonly key: string
    readonly setting: Setting<unknown>
    readonly path: ReadonlyArray<string>
    readonly title: string
  }
  | { readonly kind: "engine"; readonly secret: boolean; readonly path: ReadonlyArray<string>; readonly title: string }

const page = (path: string, titles: Readonly<Record<string, string>>) => {
  const [group = "other", id = ""] = path.split("/")
  return { path: [group, id], title: `${groupTitle[group] ?? group} › ${titles[path] ?? id}` }
}

export interface EnvCatalog {
  readonly target: (key: string) => EnvTarget | undefined
  readonly kind: (key: string) => EnvKind
}

/** What every known variable is, from the sections, the module catalog and the lists above. */
export const makeEnvCatalog = (catalog: ReadonlyArray<ModuleDefinition<any>>): EnvCatalog => {
  const targets = new Map<string, EnvTarget>()
  const titles: Record<string, string> = {}
  for (const d of sectionDefinitions()) {
    const path = `${groupSlug[d.group]}/${d.page.id}`
    titles[path] = d.page.title
  }
  for (const d of sectionDefinitions()) {
    const p = page(`${groupSlug[d.group]}/${d.page.id}`, titles)
    for (const [key, setting] of Object.entries(d.spec as SettingsSpec)) {
      if (setting.env === undefined) continue
      const assistantField = assistantFieldOf(setting.env)
      targets.set(
        setting.env,
        assistantField === undefined
          ? { kind: "section", key, setting, ...p }
          : { kind: "assistant-field", assistantId: MIGRATED_ASSISTANT_ID, field: assistantField, key, setting, ...p }
      )
    }
  }
  for (const def of catalog) {
    const group = def.kind === "agent" || def.kind === "decider" ? "language-model" : "modules"
    const p = { path: [group, def.id], title: `${groupTitle[group]} › ${def.name}` }
    for (const [key, setting] of Object.entries(def.settings as SettingsSpec)) {
      if (setting.env !== undefined && !targets.has(setting.env)) targets.set(setting.env, { kind: "module", moduleId: def.id, key, setting, ...p })
    }
  }
  const engine = (key: string): EnvTarget | undefined => {
    const direct = ENGINE_KEYS[key]
    if (direct !== undefined) return { kind: "engine", secret: false, ...page(direct, titles) }
    const voice = VOICE_KEY.exec(key)?.[1]
    if (voice === undefined) return undefined
    if (voice === "PROVIDER" || ENGINE_KEYS[voice] !== undefined || targets.has(voice)) {
      return { kind: "engine", secret: isSecretName(voice), ...page("voices/providers", titles) }
    }
    return undefined
  }
  return {
    target: (key) => targets.get(key) ?? engine(key),
    kind: (key) => {
      if (BOOTSTRAP_KEYS.has(key)) return "bootstrap"
      if (DEVELOPMENT_KEYS.has(key) || DEVELOPMENT_PREFIXES.some((p) => key.startsWith(p))) return "development"
      return targets.has(key) || engine(key) !== undefined ? "setting" : "unknown"
    }
  }
}

const isSecretTarget = (t: EnvTarget | undefined, key: string) =>
  t === undefined ? isSecretName(key) : t.kind === "engine" ? t.secret : t.setting.secret

/**
 * Every variable worth showing: all from `.env` files (an unknown one is often a typo), and the known ones from the
 * process environment. No values.
 */
export const envInfo = (view: EnvView, envCatalog: EnvCatalog): EnvInfo => {
  const entries: Array<EnvEntry> = []
  for (const key of [...new Set(view.keys())].sort()) {
    const origin = view.origin(key)
    if (origin === undefined) continue
    const kind = envCatalog.kind(key)
    const refused = Object.hasOwn(REFUSED_KEYS, key) ? REFUSED_KEYS[key] : undefined
    if (origin.kind === "process" && kind === "unknown" && refused === undefined) continue
    const target = envCatalog.target(key)
    entries.push({
      key,
      origin: origin.kind,
      ...(origin.kind === "file" ? { file: origin.path, line: origin.line } : {}),
      kind,
      secret: isSecretTarget(target, key) || BOOTSTRAP_KEYS.has(key) && isSecretName(key),
      ...(target !== undefined && kind === "setting" ? { page: { path: [...target.path], title: target.title } } : {}),
      movable: origin.kind === "file" && kind === "setting",
      ...(refused !== undefined ? { refused } : {})
    })
  }
  return { files: [...view.files], entries }
}

export interface EnvMover {
  readonly info: () => EnvInfo
  /**
   * Move `.env` values into the saved settings (keys into the vault), then comment their lines out of the files.
   * A key that cannot be moved is left as it is and named in the answer. Never logs or returns a value.
   */
  readonly move: (keys: ReadonlyArray<string>) => Effect.Effect<HostResult & { readonly moved?: ReadonlyArray<string> }>
}

export const makeEnvMover = (options: {
  readonly view: EnvView
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  readonly sections: Sections
  readonly host: ModuleHost
  readonly store: SettingsStore
  readonly vaultState: () => "none" | "locked" | "unlocked"
  /** After values moved: re-announce what changed. */
  readonly onMoved: () => void
  /** For tests. */
  readonly now?: () => Date
  readonly commentOut?: (path: string, keys: ReadonlyArray<string>, now: Date, expectedText?: string) => Promise<CommentOutResult>
}): EnvMover => {
  const envCatalog = makeEnvCatalog(options.catalog)
  const commentOut = options.commentOut ?? commentOutKeys
  const policyInput = (key: string) => key === "HOME_LANGUAGE" || Object.values(RISK_POLICY_KEYS).some((k) => k === key)
  // Advance only after our own verified rewrites, so a partial move can still be retried. Retain no secrets.
  const expectedFiles = new Map(options.view.files.map((file) => [file, Object.fromEntries(
    Object.entries(options.view.fileValues(file)).filter(([key]) => policyInput(key))
  )]))
  const pendingFiles = new Map<string, Set<string>>()
  let busy = false

  const fail = (code: "invalid_settings" | "locked" | "busy" | "internal", message: string): HostResult => ({ ok: false, error: { code, message } })

  const move = (keys: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      if (busy) return fail("busy", "Another move is still running; try again in a moment")
      const wanted = [...new Set(keys)]
      const problems: Array<string> = []
      type Planned = { readonly key: string; readonly text: string; readonly origin: EnvOrigin & { kind: "file" }; readonly target: EnvTarget }
      const planned: Array<Planned> = []
      for (const key of wanted) {
        const origin = options.view.origin(key)
        const text = options.view.record[key]
        const target = envCatalog.target(key)
        if (origin === undefined || text === undefined || text === "") problems.push(`${key} is not set`)
        else if (origin.kind !== "file") problems.push(`${key} comes from the process environment, not a .env file: unset it where it is exported`)
        else if (envCatalog.kind(key) !== "setting" || target === undefined) problems.push(`${key} cannot be set in the settings; it stays in .env`)
        else planned.push({ key, text, origin, target })
      }
      if (planned.length === 0) {
        return fail("invalid_settings", problems.join("; ") || "Nothing to move")
      }
      // Keys go to the vault: refuse them all while it is locked (nothing is changed).
      const secrets = planned.filter((p) => isSecretTarget(p.target, p.key))
      if (secrets.length > 0 && options.vaultState() === "locked") {
        return fail("locked", `Unlock the key vault first (Settings → Keys & access): ${secrets.map((p) => p.key).join(", ")} ${secrets.length === 1 ? "goes" : "go"} into it`)
      }

      busy = true
      try {
        const policyKeys = planned.filter((p) => policyInput(p.key)).map((p) => p.key)
        const checkedFiles = new Map<string, string>()
        if (policyKeys.length > 0) {
          for (const file of options.view.files) {
            const current = yield* Effect.tryPromise(async () => {
              const text = await readFile(file, "utf8")
              return { text, values: parseEnv(text) }
            }).pipe(Effect.result)
            if (current._tag === "Success") {
              // A rename can succeed before its verification read fails. Absence on Retry completes that check.
              for (const key of pendingFiles.get(file) ?? []) {
                if (current.success.values[key] === undefined) {
                  delete expectedFiles.get(file)![key]
                  pendingFiles.get(file)!.delete(key)
                }
              }
              checkedFiles.set(file, current.success.text)
            }
            if (current._tag === "Failure" || policyKeys.some((key) => current.success.values[key] !== expectedFiles.get(file)?.[key])) {
              return fail("invalid_settings", `${file} changed or could not be read: restart the assistant to reload .env files before moving these settings`)
            }
          }
        }
        const moved: Array<Planned> = []
        for (const p of planned) {
          const secret = isSecretTarget(p.target, p.key)
          // The value is checked like one typed on the page (no value in the message).
          if (p.target.kind !== "engine") {
            const decoded = p.target.setting.fromEnv(p.text)
            if (!decoded.ok || (secret && p.text.trim() === "")) {
              problems.push(`${p.key}: the value in .env is not valid for this setting; fix it there or set it on its page`)
              continue
            }
          }
          // Keep policy inputs effective and locked through saving AND removing every file declaration.
          // Home language is published with the policy, so it needs the same ordering as the risk keys.
          const retained = policyInput(p.key)
          if (!retained) options.view.release(p.key)
          const saved = yield* retained ? Effect.uninterruptible(save(p, secret)) : save(p, secret)
          if (!saved.ok) {
            if (!retained) options.view.restore(p.key, p.text, p.origin)
            problems.push(`${p.key}: ${saved.message}`)
            continue
          }
          moved.push(p)
        }
        if (moved.length > 0) {
          yield* Effect.uninterruptible(Effect.gen(function*() {
            // Saving can yield to a hand edit. Check every loaded path again before removing any declaration.
            for (const [file, text] of checkedFiles) {
              const unchanged = yield* Effect.tryPromise(async () => await readFile(file, "utf8") === text).pipe(Effect.result)
              if (unchanged._tag === "Failure" || !unchanged.success) {
                problems.push(`${file} changed or could not be read: retry the move; if the file was edited by hand, restart the assistant to reload .env files first`)
                return
              }
            }
            // Remove shadowed declarations first and the winning one last. If a rewrite fails, leave earlier
            // declarations of that key in place: even a restart during this step still reads the chosen value.
            const byFile = new Map<string, Array<string>>()
            for (const file of [...options.view.files].reverse()) {
              const fileKeys = moved.filter((p) => policyInput(p.key)
                ? expectedFiles.get(file)?.[p.key] !== undefined
                : p.origin.path === file).map((p) => p.key)
              if (fileKeys.length > 0) byFile.set(file, fileKeys)
            }
            const failedKeys = new Set<string>()
            for (const [file, plannedKeys] of byFile) {
              const fileKeys = plannedKeys.filter((key) => !failedKeys.has(key))
              if (fileKeys.length === 0) continue
              const result = yield* Effect.tryPromise(async () => {
                const rewritten = await commentOut(file, fileKeys, (options.now ?? (() => new Date()))(), checkedFiles.get(file))
                const pending = pendingFiles.get(file) ?? new Set<string>()
                for (const key of fileKeys.filter(policyInput)) pending.add(key)
                pendingFiles.set(file, pending)
                // A completed write is not proof that the line scanner removed every Node-readable assignment.
                const remaining = parseEnv(await readFile(file, "utf8"))
                const before = checkedFiles.has(file) ? parseEnv(checkedFiles.get(file)!) : undefined
                if (before !== undefined && [...new Set([...Object.keys(before), ...Object.keys(remaining)])]
                  .some((key) => !fileKeys.includes(key) && before[key] !== remaining[key])) {
                  throw new Error("Another environment value changed after rewriting")
                }
                if (fileKeys.some((key) => Object.hasOwn(remaining, key))) throw new Error("An environment assignment remains after rewriting")
                return rewritten
              }).pipe(Effect.result)
              if (result._tag === "Failure") {
                for (const key of fileKeys) failedKeys.add(key)
                const code = (result.failure.cause as NodeJS.ErrnoException | undefined)?.code ?? "error"
                problems.push(`${fileKeys.join(", ")} saved, but ${file} could not be changed (${code}): retry the move; if the file was edited by hand, restart the assistant to reload .env files first`)
                yield* Effect.logWarning(`Moved ${fileKeys.join(", ")} into the settings, but could not edit ${file} (${code})`)
              } else {
                const expected = expectedFiles.get(file)
                if (expected !== undefined) for (const key of fileKeys) {
                  delete expected[key]
                  pendingFiles.get(file)?.delete(key)
                }
                yield* Effect.logInfo(`Moved ${fileKeys.join(", ")} from ${file} into the settings (backup: ${result.success.backup})`)
              }
            }
            // Even a path with no original declaration must be free of the moved key before unlocking.
            const movedPolicyKeys = moved.filter((p) => policyInput(p.key) && !failedKeys.has(p.key)).map((p) => p.key)
            if (movedPolicyKeys.length > 0) for (const file of options.view.files) {
              const remaining = yield* Effect.tryPromise(async () => parseEnv(await readFile(file, "utf8"))).pipe(Effect.result)
              const unverified = movedPolicyKeys.filter((key) => remaining._tag === "Failure" || Object.hasOwn(remaining.success, key))
              if (unverified.length > 0) {
                for (const key of unverified) failedKeys.add(key)
                problems.push(`${unverified.join(", ")} saved, but ${file} could not be verified: retry the move; if the file was edited by hand, restart the assistant to reload .env files first`)
              }
            }
            for (const p of moved) if (policyInput(p.key) && !failedKeys.has(p.key)) options.view.release(p.key)
            if (moved.some((p) => !failedKeys.has(p.key))) {
              options.sections.announceAll()
              options.onMoved()
            }
          }))
        }
        if (problems.length > 0) {
          return { ...fail("invalid_settings", problems.join("; ")), moved: moved.map((p) => p.key) }
        }
        return { ok: true, moved: moved.map((p) => p.key) } as const
      } finally {
        busy = false
      }
    })

  /** Save one value: a section field or engine key by key in the store, a module field through the host. */
  const save = (p: { readonly key: string; readonly text: string; readonly target: EnvTarget }, secret: boolean) =>
    Effect.gen(function*() {
      if (p.target.kind === "module") {
        const patch: SettingsPatch = secret
          ? { values: {}, secrets: { [p.target.key]: p.text } }
          : { values: { [p.target.key]: decodedValue(p.target.setting, p.text) as SettingValue }, secrets: {} }
        const r = yield* options.host.configure(p.target.moduleId, patch, { includeHidden: true })
        return r.ok ? { ok: true as const } : { ok: false as const, message: r.error.message }
      }
      // A section field or an assistant field by its flat key (the store mirrors the latter into the assistant), or
      // an engine key as it is.
      const storeKey = p.target.kind === "engine" ? p.key : p.target.key
      const value = p.target.kind === "engine" ? p.text : decodedValue(p.target.setting, p.text)
      const r = yield* Effect.result(
        options.store.saveAssistant([storeKey], secret ? {} : { [storeKey]: value as SettingValue }, secret ? { [storeKey]: p.text } : {})
      )
      return r._tag === "Success" ? { ok: true as const } : { ok: false as const, message: r.failure.message }
    })

  return { info: () => envInfo(options.view, envCatalog), move }
}

const decodedValue = (setting: Setting<unknown>, text: string): unknown => {
  const decoded = setting.fromEnv(text)
  return decoded.ok ? decoded.value : undefined
}
