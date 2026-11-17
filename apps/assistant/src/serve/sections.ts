import { applySettingsPatch, type HostResult, parseVoiceKey, resolveSettings, runSettingsChecks, type SettingsSources } from "@pva/core"
import type { FieldError, SettingsPatch, SettingsSection, SettingValue } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { ConfigProvider, Effect, Semaphore } from "effect"
import { type ModelDirs, type SectionDefinition, sectionDefinitions, sectionPath } from "./sectionDefinitions.ts"
import type { SettingsStore } from "./SettingsStore.ts"

/**
 * Assistant settings (docs/UI-AND-MODULES.md §1.7, docs/SETTINGS-UI.md §4):
 * voices, engines and turn detection, built with the same `Setting`
 * constructors as modules and keyed by their environment variable names.
 * Values are stored flat by key; the sections (`sectionDefinitions.ts`) only
 * place them on the settings screen. Saved values reach the providers through
 * a `ConfigProvider` placed under the environment, so the adapters read their
 * settings exactly as before.
 */

export interface SectionUpdate {
  readonly result: HostResult
  /** A field that needs an engine reload changed. */
  readonly reload: boolean
  /** The settings page of the section (`<group>/<page>`), for `reloadPendingFor`. */
  readonly path: string
}

export interface Sections {
  readonly list: () => ReadonlyArray<SettingsSection>
  /**
   * Validate and save a patch. Cross-field checks run on the values the save would produce: a new error refuses
   * it, new warnings refuse it until `confirmWarnings` (answered `invalid_settings` with `warnings`).
   */
  readonly update: (id: string, patch: SettingsPatch, options?: { readonly confirmWarnings?: boolean }) => Effect.Effect<SectionUpdate>
  /** The effective value of a field (environment > saved > default). */
  readonly value: (key: string) => SettingValue | undefined
  /** Environment first, then the saved values and secrets: what the providers read. */
  readonly configProvider: () => ConfigProvider.ConfigProvider
  /** Called with a section after it changed. */
  readonly subscribe: (listener: (section: SettingsSection) => void) => () => void
  /**
   * Announce every section again with a new revision (the secrets behind them changed: the key vault was unlocked or
   * locked; a value left the environment; a model was downloaded).
   */
  readonly announceAll: () => void
  /** Where the recogniser's and the voices' models are (environment > saved > `<repo>/models`). */
  readonly modelDirs: () => ModelDirs
}

/**
 * A voice on this machine whose model is missing cannot be saved as the assistant's voice (the reload would fail):
 * download it first (docs/VOICE-PROVIDERS.md §6.1).
 */
const checkLocalVoice = (patch: SettingsPatch, dir: string): ReadonlyArray<FieldError> => {
  const value = patch.values.ASSISTANT_VOICE
  if (typeof value !== "string") return []
  const ref = parseVoiceKey(value.trim())
  if (ref === undefined || ref.provider !== "sherpa") return []
  const preset = Object.hasOwn(SherpaTts.presets, ref.voiceId) ? SherpaTts.presets[ref.voiceId] : undefined
  if (preset === undefined) return [{ key: "ASSISTANT_VOICE", message: `There is no voice "${ref.voiceId}" on this machine` }]
  if (SherpaTts.isInstalled(preset.name, dir)) return []
  return [{ key: "ASSISTANT_VOICE", message: `${preset.voice.name} is not downloaded yet: download it first (${preset.sizeMb} MB)` }]
}

/** Saved values from earlier versions: renamed recogniser presets. */
const migrate = (values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const model = values.STT_SHERPA_MODEL
  if (typeof model !== "string" || SherpaStt.isPresetName(model)) return values
  const renamed = SherpaStt.resolvePresetName(model)
  return renamed === undefined ? values : { ...values, STT_SHERPA_MODEL: renamed }
}

/**
 * A recogniser preset whose files are missing cannot be saved (the reload would fail): the settings page offers
 * Download next to it first, so this only answers a page that skipped that.
 */
const checkModel = (patch: SettingsPatch, dir: string): ReadonlyArray<FieldError> => {
  const model = patch.values.STT_SHERPA_MODEL
  if (typeof model !== "string" || !SherpaStt.isPresetName(model)) return []
  if (SherpaStt.isInstalled(model, dir)) return []
  const size = SherpaStt.sizeMb(SherpaStt.presets[model] as SherpaStt.Preset)
  return [{ key: "STT_SHERPA_MODEL", message: `${SherpaStt.presets[model].label} is not downloaded yet: download it first (${size} MB)` }]
}

const encode = (value: unknown): string =>
  Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : String(value)

const problemKey = (e: FieldError) => `${e.key ?? ""}\u0000${e.message}`
const newProblems = (before: ReadonlyArray<FieldError>, after: ReadonlyArray<FieldError>) => {
  const seen = new Set(before.map(problemKey))
  return after.filter((e) => !seen.has(problemKey(e)))
}

/** What the screen and the providers see for one state of the saved values. */
interface View {
  readonly sections: ReadonlyArray<SettingsSection>
  readonly values: ReadonlyMap<string, unknown>
  readonly secretSet: (key: string) => boolean
  readonly errors: ReadonlyArray<FieldError>
  readonly warnings: ReadonlyArray<FieldError>
}

export const makeSections = (
  store: SettingsStore,
  /** Read live: a key released from it ("Move to settings") stops counting at once. */
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly envOrigin?: (name: string) => "env-file" | "env-process"
    readonly envLocation?: (name: string) => { readonly file: string; readonly line: number } | undefined
  } = {}
): Sections => {
  const revisions = new Map<string, number>()
  const listeners = new Set<(section: SettingsSection) => void>()
  const origin = {
    ...(options.envOrigin !== undefined ? { envOrigin: options.envOrigin } : {}),
    ...(options.envLocation !== undefined ? { envLocation: options.envLocation } : {})
  }
  const modelDirs = (): ModelDirs => {
    const pick = (key: string, fallback: string) => {
      const fromEnv = env[key]
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv
      const saved = store.settings().assistant[key]
      return typeof saved === "string" && saved !== "" ? saved : fallback
    }
    return { stt: pick("STT_SHERPA_MODEL_DIR", SherpaStt.defaultModelDir), tts: pick("TTS_SHERPA_MODEL_DIR", SherpaTts.defaultModelDir) }
  }

  /**
   * Resolve every section against flat saved values: values first (they do not depend on visibility), then each
   * form with the others as `context`, so a hidden field is not validated; then the cross-field checks.
   */
  const view = (
    definitions: ReadonlyArray<SectionDefinition>,
    stored: Readonly<Record<string, unknown>>,
    secrets: Readonly<Record<string, string>>
  ): View => {
    const base = (d: SectionDefinition, context?: (key: string) => unknown): SettingsSources => ({
      stored,
      secrets,
      env,
      ...origin,
      ...(context !== undefined ? { context } : {})
    })
    const values = new Map<string, unknown>()
    const secretSet = new Map<string, boolean>()
    for (const d of definitions) {
      const form = resolveSettings(d.spec, base(d)).form
      for (const [key, value] of Object.entries(form.values)) values.set(key, value)
      for (const [key, state] of Object.entries(form.secrets)) secretSet.set(key, state.set)
    }
    const checkView = { value: (key: string) => values.get(key), secretSet: (key: string) => secretSet.get(key) === true }
    const errors: Array<FieldError> = []
    const warnings: Array<FieldError> = []
    const sections = definitions.map((d): SettingsSection => {
      const form = resolveSettings(d.spec, base(d, (key) => values.get(key))).form
      const checked = runSettingsChecks(d.checks ?? [], checkView)
      errors.push(...checked.errors)
      warnings.push(...checked.warnings)
      return {
        id: d.id,
        title: d.title,
        ...(d.description !== undefined ? { description: d.description } : {}),
        group: d.group,
        page: d.page,
        order: d.order,
        ...(d.visibleWhen !== undefined ? { visibleWhen: d.visibleWhen } : {}),
        ...(d.protected === true ? { protected: true } : {}),
        form: {
          ...form,
          errors: [...form.errors, ...checked.errors],
          ...(checked.warnings.length > 0 ? { warnings: checked.warnings } : {})
        },
        revision: revisions.get(d.id) ?? 0
      }
    })
    return { sections, values, secretSet: checkView.secretSet, errors, warnings }
  }

  const saved = () => ({ stored: migrate(store.settings().assistant), secrets: store.secrets().assistant })
  const current = () => {
    const { stored, secrets } = saved()
    return view(sectionDefinitions(modelDirs()), stored, secrets)
  }

  // `value` is read on the turn path (system prompt, default voice): cached until the saved values or the keys change.
  let values: ReadonlyMap<string, unknown> | undefined
  const effective = () => (values ??= current().values)

  const nonEmptyEnv = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) if (value !== undefined && value !== "") out[key] = value
    return out
  }

  const announce = (sections: ReadonlyArray<SettingsSection>) => {
    for (const section of sections) for (const listener of listeners) listener(section)
  }
  const failed = (path: string, error: HostResult & { readonly ok: false }): SectionUpdate => ({ result: error, reload: false, path })
  // Read, validate and save as one step: two saves at once must not each start from the old values.
  const updateLock = Semaphore.makeUnsafe(1)

  return {
    list: () => current().sections,
    value: (key) => effective().get(key) as SettingValue | undefined,
    update: (id, patch, updateOptions = {}) =>
      updateLock.withPermit(Effect.gen(function*() {
        const definitions = sectionDefinitions(modelDirs())
        const d = definitions.find((s) => s.id === id)
        if (d === undefined) {
          return failed("", { ok: false, error: { code: "unknown_section", message: `There is no settings section "${id}"` } })
        }
        const path = sectionPath(d)
        const { stored, secrets } = saved()
        const before = view(definitions, stored, secrets)
        const missingModel = [...checkModel(patch, modelDirs().stt), ...checkLocalVoice(patch, modelDirs().tts)]
        if (missingModel.length > 0) {
          return failed(path, { ok: false, error: { code: "invalid_settings", message: missingModel[0]!.message, fieldErrors: missingModel } })
        }
        let patched = applySettingsPatch(d.spec, { stored, secrets, env, ...origin, context: (key) => before.values.get(key) }, patch)
        if (!patched.ok) {
          return failed(path, { ok: false, error: { code: "invalid_settings", message: "Some settings are not valid", fieldErrors: patched.errors } })
        }
        // P5: a section may complete its values before they are written (Members gives a new person an id).
        if (d.normalize !== undefined) patched = { ...patched, stored: d.normalize(patched.stored) }
        // The values after this save, for every section (keys are global).
        const keys = Object.keys(d.spec)
        const replace = <V>(base: Readonly<Record<string, V>>, next: Readonly<Record<string, V>>) => {
          const out: Record<string, V> = { ...base }
          for (const key of keys) {
            if (Object.hasOwn(next, key)) out[key] = next[key]!
            else delete out[key]
          }
          return out
        }
        const after = view(definitions, replace(stored, patched.stored), replace(secrets, patched.secrets))
        const errors = newProblems(before.errors, after.errors)
        if (errors.length > 0) {
          return failed(path, { ok: false, error: { code: "invalid_settings", message: errors[0]!.message, fieldErrors: errors } })
        }
        const warnings = newProblems(before.warnings, after.warnings)
        if (warnings.length > 0 && updateOptions.confirmWarnings !== true) {
          return failed(path, {
            ok: false,
            error: { code: "invalid_settings", message: "Check the warnings below, then save anyway or change the settings", warnings }
          })
        }
        const result = yield* Effect.result(store.saveAssistant(keys, patched.stored, patched.secrets))
        if (result._tag === "Failure") {
          yield* Effect.logError(result.failure.message, result.failure.cause)
          return failed(path, { ok: false, error: { code: "internal", message: `${result.failure.message}; nothing was changed` } })
        }
        const needsReload = keys.some((key) => {
          const field = d.spec[key]?.describe(key)
          if (field === undefined || field.apply !== "reload") return false
          return field.type === "secret"
            ? secrets[key] !== patched.secrets[key]
            : JSON.stringify(stored[key]) !== JSON.stringify(patched.stored[key])
        })
        values = undefined
        // This section, and every other one whose form changed (visibility, warnings), gets a new revision.
        const next = current()
        const changed = next.sections.filter((s, i) =>
          s.id === id || JSON.stringify(s.form) !== JSON.stringify(before.sections[i]?.form)
        )
        for (const s of changed) revisions.set(s.id, (revisions.get(s.id) ?? 0) + 1)
        announce(current().sections.filter((s) => changed.some((c) => c.id === s.id)))
        return { result: { ok: true }, reload: needsReload, path } as const
      })),
    configProvider: () => {
      const values: Record<string, string> = {}
      const { stored, secrets } = saved()
      for (const [key, value] of Object.entries(stored)) values[key] = encode(value)
      for (const [key, value] of Object.entries(secrets)) values[key] = value
      return ConfigProvider.orElse(ConfigProvider.fromEnvRecord(nonEmptyEnv()), ConfigProvider.fromEnvRecord(values))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    announceAll: () => {
      values = undefined
      for (const d of sectionDefinitions(modelDirs())) revisions.set(d.id, (revisions.get(d.id) ?? 0) + 1)
      announce(current().sections)
    },
    modelDirs
  }
}
