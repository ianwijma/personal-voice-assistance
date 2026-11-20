/**
 * The conformance check every module's test calls (docs/MODULES.md, "Testing: checkModule"):
 * `yield* checkModule(definition, { settings? })` starts the module in the real host through the test kit
 * (`startTestModule`) and fails, naming each rule and the place, for what the docs state as a rule a module can break
 * without noticing. `moduleProblems` answers the list instead of failing. Exported from `@pva/core/testing` only.
 *
 * It checks the definition, the start, and what the module declares and does **while it starts**: it runs no tool,
 * action or job, so what those do (their results, the jobs they schedule, what they speak) is for the module's own
 * tests (docs/MODULES.md, "What your tests must cover").
 *
 * The rules (`ModuleProblem.rule`):
 *
 * | rule | what fails |
 * |---|---|
 * | `api-version` | the module does not declare `apiVersion: 2` |
 * | `off-by-default` | a new module is on before the owner chose (`enabledByDefault` not `false`) |
 * | `form` | its described settings form does not encode with the wire's schema or exceeds its budget |
 * | `start` | it does not start in the real host with the given settings and secrets (the host refuses, among others, a tool name providers refuse, a name used twice, an action whose generated tool name is over 64 characters) |
 * | `secret` | a secret's value appears in a status line, an error, a form, a Health issue, a tool's name or description, an action's text, instructions or a context provider's name |
 * | `risk` | a tool or action that is not a plain read (`speculative: true`) declares no risk class |
 * | `risk-said` | one that can be `money` or `security` (refused by the gateway's risk policy) does not say so in its description |
 * | `tool-name` | a tool's name, or an action's generated tool name `<moduleId>_<actionId>`, is not 1–64 of `[A-Za-z0-9_-]`, or a name is used twice in one instance |
 * | `tool-description` | a tool's description, or an action's generated tool's, is empty or over 1,024 characters |
 * | `tool-parameters` | a tool's parameters, or an action's generated tool's, are not sent as a JSON object schema, or name a property outside 1–64 of `[A-Za-z0-9_.-]` |
 * | `action-examples` | an action declares no `examples` (the keyword decider and the model have nothing to match) |
 * | `collection` | the store's declaration check (`defineCollection`, and `prepare` on an empty store) refuses a collection it declares |
 * | `stored-value` | a collection's worst legal value is longer than its `maxChars`, or has no bound |
 * | `scheduler-shared` | a scheduler handler is registered in an instance's `start` instead of `shared` |
 * | `scheduler-refused` | a `schedule`, `prepare` or `reschedule` it made while starting was refused by the real engine (a cron or time zone, a payload, a limit), with the engine's reason |
 * | `health` | it requires the network but declares no `health`, or its `health()` fails, dies or does not answer in time |
 * | `texts` | the spoken texts it declares (`options.texts`) differ between English and Dutch in keys or in the set of placeholder names, or one is empty or not one line |
 *
 * Every instance the household's assistants make (one per distinct set of effective settings) is checked; a problem
 * two instances share is reported once.
 *
 * What it does not judge: whether an indexed value is legal for the store (the store refuses an illegal one when it
 * is written, and a module's own tests write a row with every indexed field at its largest), and any value a tool,
 * an action or a job produces.
 */
import { Data, Effect, Schema } from "effect"
import { type Collection, defineCollection } from "./HouseholdStore.ts"
import type { ModuleDefinition } from "./ModuleDefinition.ts"
import type { StartedPart } from "./ModuleRegistrations.ts"
import { toolMetadata, type Tool } from "./Module.ts"
import { type ActionDefinition, actionTool, registerActions } from "./Actions.ts"
import { toolSpec } from "./ToolRegistry.ts"
import { recordParts, startTestModule, type StartTestModuleOptions } from "./ModuleTestKit.ts"
import { makeMemoryHouseholdStore } from "./MemoryHouseholdStore.ts"
import { NOT_ONE_LINE } from "./SettingsExtra.ts"

export interface ModuleProblem {
  /** The rule's id (the table above). */
  readonly rule: string
  /** Where: "tool lists_add", "collection notes, field text", "settings". */
  readonly where: string
  readonly message: string
}

export interface CheckModuleOptions extends Pick<StartTestModuleOptions, "settings" | "secrets" | "provide" | "others" | "household"> {
  /** The module's spoken texts (`defineTexts` of `@pva/module-contracts`), checked for both languages. */
  readonly texts?: { readonly en: Readonly<Record<string, string>>; readonly nl: Readonly<Record<string, string>> }
  /** Only for the two built-in modules that were on before this stack (clock, weather): skip `off-by-default`. */
  readonly onByDefault?: true
}

export class ModuleCheckFailed extends Data.TaggedError("ModuleCheckFailed")<{ readonly moduleId: string; readonly problems: ReadonlyArray<ModuleProblem> }> {
  override get message(): string {
    return `Module ${this.moduleId} breaks ${this.problems.length} rule${this.problems.length === 1 ? "" : "s"} (docs/MODULES.md, "Testing: checkModule"):\n${
      this.problems.map((p) => `- [${p.rule}] ${p.where}: ${p.message}`).join("\n")
    }`
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The worst legal value of a stored collection

/**
 * The pattern of `StoredText` (`@pva/module-contracts`): no control characters but tab, line feed, carriage return,
 * backspace and form feed, no lone surrogates. Each such character costs at most two characters of JSON. The contracts
 * package keeps the same text (a test compares them).
 */
export const STORED_TEXT_PATTERN_SOURCE = "^[^\\u0000-\\u0007\\u000b\\u000e-\\u001f\\ud800-\\udfff]*$"

/**
 * The most characters `JSON.stringify` writes for a finite JavaScript number: a sign, 17 significant digits, a point
 * and the longest place for it (`-0.0000010000000000000002` is 25; `-1.7976931348623157e+308` is 24).
 */
const NUMBER_CHARS = 25

type Worst = { readonly chars: number } | { readonly unbounded: string }

/**
 * The most characters of JSON a value of this JSON Schema can take (`JSON.stringify`, the store's `maxChars`
 * measure), or the path of the first part that has no bound. Every optional field is counted as present; a string
 * costs 6 characters of JSON per UTF-16 unit (a control character's `\u0000` escape), 2 when it is a `StoredText`;
 * a number 25 (an integer between bounds, the longer bound).
 */
export const worstJsonChars = (document: { readonly schema: unknown; readonly definitions?: Readonly<Record<string, unknown>> }): Worst => {
  const defs = document.definitions ?? {}
  const walk = (node: unknown, path: string, depth: number): Worst => {
    if (depth > 32) return { unbounded: `${path} (recursive)` }
    if (typeof node !== "object" || node === null) return node === false ? { chars: 0 } : { unbounded: path }
    const s = node as Record<string, unknown>
    if (typeof s.$ref === "string") {
      const name = s.$ref.replace(/^#\/(\$defs|definitions)\//, "")
      return walk(defs[name], path, depth + 1)
    }
    if (Array.isArray(s.enum)) return { chars: Math.max(...s.enum.map((v) => JSON.stringify(v).length)) }
    if ("const" in s) return { chars: JSON.stringify(s.const).length }
    const union = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined) as ReadonlyArray<unknown> | undefined
    if (union !== undefined) {
      let most = 0
      for (const [i, m] of union.entries()) {
        const w = walk(m, `${path}|${i}`, depth + 1)
        if ("unbounded" in w) return w
        most = Math.max(most, w.chars)
      }
      return { chars: most }
    }
    const type = s.type
    if (Array.isArray(type)) return walk({ anyOf: type.map((t) => ({ ...s, type: t })) }, path, depth + 1)
    switch (type) {
      case "null":
        return { chars: 4 }
      case "boolean":
        return { chars: 5 }
      case "integer":
      case "number": {
        if (type === "integer" && typeof s.minimum === "number" && typeof s.maximum === "number") {
          return { chars: Math.max(String(s.minimum).length, String(s.maximum).length) }
        }
        return { chars: NUMBER_CHARS }
      }
      case "string": {
        if (typeof s.maxLength !== "number") return { unbounded: `${path} (a string without a maximum length)` }
        return { chars: 2 + s.maxLength * (s.pattern === STORED_TEXT_PATTERN_SOURCE ? 2 : 6) }
      }
      case "array": {
        let chars = 2
        let count = 0
        const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as ReadonlyArray<unknown>) : []
        for (const [i, item] of prefix.entries()) {
          const w = walk(item, `${path}[${i}]`, depth + 1)
          if ("unbounded" in w) return w
          chars += w.chars
          count++
        }
        if (s.items !== undefined && s.items !== false) {
          if (typeof s.maxItems !== "number") return { unbounded: `${path} (a list without a maximum number of items)` }
          const rest = Math.max(0, s.maxItems - prefix.length)
          if (rest > 0) {
            const w = walk(s.items, `${path}[]`, depth + 1)
            if ("unbounded" in w) return w
            chars += rest * w.chars
            count += rest
          }
        }
        return { chars: chars + Math.max(0, count - 1) }
      }
      case "object": {
        const extra = s.additionalProperties
        const props = (s.properties ?? {}) as Record<string, unknown>
        if ((typeof extra === "object" && extra !== null) || s.patternProperties !== undefined) {
          return { unbounded: `${path} (a record without a bound on its keys)` }
        }
        let chars = 2
        const keys = Object.keys(props)
        for (const k of keys) {
          const w = walk(props[k], path === "" ? k : `${path}.${k}`, depth + 1)
          if ("unbounded" in w) return w
          chars += JSON.stringify(k).length + 1 + w.chars
        }
        return { chars: chars + Math.max(0, keys.length - 1) }
      }
      default:
        return { unbounded: `${path === "" ? "the value" : path} (a type with no bound)` }
    }
  }
  return walk(document.schema, "", 0)
}

/** `worstJsonChars` of a collection's stored form (its schema's JSON form, as the store keeps it). */
export const collectionWorst = (collection: Pick<Collection<any>, "schema">): Worst => {
  try {
    return worstJsonChars(Schema.toJsonSchemaDocument(Schema.toCodecJson(collection.schema as Schema.Codec<unknown, unknown>)))
  } catch (e) {
    return { unbounded: `its schema has no JSON form (${e instanceof Error ? e.message : String(e)})` }
  }
}

/**
 * Why the store's declaration check refuses a collection, or nothing: its own `defineCollection`, run again on what the
 * module declares (a collection object made by hand does not pass through it). It judges the declaration only; what a
 * value may hold, an indexed value included, the store checks when the value is written.
 */
export const collectionProblems = (collection: Collection<any>): ReadonlyArray<string> => {
  try {
    defineCollection({
      name: collection.name,
      scope: collection.scope,
      schema: collection.schema,
      maxChars: collection.maxChars,
      indexes: collection.indexes,
      migrate: collection.migrate,
      ...(collection.ambient !== undefined ? { ambient: collection.ambient, ambientRows: collection.ambientRows } : {}),
      ...(collection.project !== undefined ? { project: collection.project } : {})
    })
    return []
  } catch (e) {
    return [`the store refuses its declaration: ${e instanceof Error ? e.message : String(e)}`]
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The check

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_TOOL_DESCRIPTION = 1_024
const SENTINEL = (key: string) => `pva-check-secret-${key}-7d1f`
/** The names of a text's placeholders, each once, sorted (`say` fills every occurrence of a name). */
const PLACEHOLDERS = (text: string) => [...new Set([...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!))].sort()

const textsProblems = (texts: NonNullable<CheckModuleOptions["texts"]>): Array<ModuleProblem> => {
  const out: Array<ModuleProblem> = []
  const keys = new Set([...Object.keys(texts.en), ...Object.keys(texts.nl)])
  for (const key of keys) {
    const en = texts.en[key]
    const nl = texts.nl[key]
    if (en === undefined || nl === undefined) {
      out.push({ rule: "texts", where: `text "${key}"`, message: `it exists in ${en === undefined ? "Dutch" : "English"} only` })
      continue
    }
    for (const [lang, t] of [["English", en], ["Dutch", nl]] as const) {
      if (t.trim() === "") out.push({ rule: "texts", where: `text "${key}"`, message: `the ${lang} text is empty` })
      if (NOT_ONE_LINE.test(t)) out.push({ rule: "texts", where: `text "${key}"`, message: `the ${lang} text is not one line` })
    }
    if (PLACEHOLDERS(en).join(",") !== PLACEHOLDERS(nl).join(",")) {
      out.push({ rule: "texts", where: `text "${key}"`, message: `its placeholder names differ: {${PLACEHOLDERS(en).join("}, {")}} in English, {${PLACEHOLDERS(nl).join("}, {")}} in Dutch` })
    }
  }
  return out
}

/** The rules every tool the model is sent keeps: an own tool, or an action's generated tool (as the host makes it). */
const wireProblems = (where: string, tool: Tool, out: Array<ModuleProblem>) => {
  if (tool.description.trim() === "" || tool.description.length > MAX_TOOL_DESCRIPTION) {
    out.push({ rule: "tool-description", where, message: `a description is 1 to ${MAX_TOOL_DESCRIPTION} characters (it has ${tool.description.length}${tool.action !== undefined ? ", with the action's label the host puts before it" : ""})` })
  }
  try {
    // The schema exactly as it is sent (`toolSpec`): a tool without parameters is `{ type: "object", properties: {} }`.
    const top = toolSpec(tool).inputSchema as Record<string, unknown>
    if (top.type !== "object") out.push({ rule: "tool-parameters", where, message: "its parameters must be an object (a Schema.Struct): model providers take only an object as a tool's input" })
    for (const name of Object.keys((top.properties ?? {}) as object)) {
      if (!PROPERTY_NAME.test(name)) out.push({ rule: "tool-parameters", where, message: `the parameter "${name}" is not 1–64 of A–Z, a–z, 0–9, _ . and -` })
    }
  } catch (e) {
    out.push({ rule: "tool-parameters", where, message: `its parameters have no JSON Schema (${e instanceof Error ? e.message : String(e)})` })
  }
}

const toolProblems = (moduleId: string, tools: ReadonlyArray<Tool>, actions: ReadonlyArray<ActionDefinition<any>>): Array<ModuleProblem> => {
  const out: Array<ModuleProblem> = []
  const seen = new Set<string>()
  const riskSaid = (where: string, description: string, meta: Parameters<typeof toolMetadata>[0]) => {
    for (const c of toolMetadata(meta).risks) {
      if ((c === "money" || c === "security") && !description.toLowerCase().includes(c)) {
        out.push({ rule: "risk-said", where, message: `it can be "${c}" (the gateway's risk policy refuses it), and its description does not say "${c}"` })
      }
    }
  }
  for (const tool of tools) {
    const where = `tool ${tool.name}`
    if (!TOOL_NAME.test(tool.name)) out.push({ rule: "tool-name", where, message: "a tool name is 1–64 of A–Z, a–z, 0–9, _ and - (what Anthropic and OpenAI accept)" })
    if (seen.has(tool.name)) out.push({ rule: "tool-name", where, message: "the name is used twice" })
    seen.add(tool.name)
    if (tool.risk === undefined && tool.speculative !== true) {
      out.push({ rule: "risk", where, message: "it is not a plain read (speculative: true) and declares no risk: declare risk: \"change\" (or the class it is)" })
    }
    riskSaid(where, tool.description, tool)
    wireProblems(where, tool, out)
  }
  for (const action of actions) {
    const name = `${moduleId}_${action.id}`
    const where = `action ${action.id}`
    if (!TOOL_NAME.test(name)) {
      out.push({ rule: "tool-name", where, message: `its generated tool name "${name}" is not 1–64 of A–Z, a–z, 0–9, _ and -: shorten the action id` })
    }
    if (action.offerAsTool !== false) {
      if (seen.has(name)) out.push({ rule: "tool-name", where, message: `its generated tool name "${name}" is also a tool's name` })
      seen.add(name)
      try {
        // The tool the host offers the model for it: its name, its description (the label before it), its parameters.
        const [registered] = registerActions(moduleId, [action])
        wireProblems(where, actionTool(registered!), out)
      } catch (e) {
        out.push({ rule: "tool-parameters", where, message: `it cannot be offered as a tool (${e instanceof Error ? e.message : String(e)})` })
      }
    }
    if (action.risk === undefined && action.speculative !== true) {
      out.push({ rule: "risk", where, message: "it is not a plain read (speculative: true) and declares no risk: declare risk: \"change\" (or the class it is)" })
    }
    riskSaid(where, action.description, action)
    if ((action.examples ?? []).length === 0) out.push({ rule: "action-examples", where, message: "it declares no examples: the keyword decider and the decision model match on them" })
  }
  return out
}

/** Every rule the module breaks (an empty list: none). Inside `it.effect`. */
export const moduleProblems = (definition: ModuleDefinition<any>, options: CheckModuleOptions = {}): Effect.Effect<ReadonlyArray<ModuleProblem>> =>
  Effect.scoped(Effect.gen(function*() {
    const id = definition.id
    const out: Array<ModuleProblem> = []
    if (definition.apiVersion !== 2) out.push({ rule: "api-version", where: "definition", message: "a module of this stack declares apiVersion: 2" })
    if (options.onByDefault !== true && definition.enabledByDefault !== false) {
      out.push({ rule: "off-by-default", where: "definition", message: "a new module is off until the owner switches it on: enabledByDefault: false" })
    }
    const hasNetwork = (definition.requires ?? []).some((r) => "network" in r)
    if (hasNetwork && definition.health === undefined) out.push({ rule: "health", where: "definition", message: "it needs the network: declare health() so the Health page and doctor can say what is wrong" })
    let storable = true
    for (const c of definition.storage?.collections ?? []) {
      const refused = collectionProblems(c)
      for (const message of refused) out.push({ rule: "collection", where: `collection ${c.name}`, message })
      if (refused.length > 0) storable = false
      const w = collectionWorst(c)
      if ("unbounded" in w) out.push({ rule: "stored-value", where: `collection ${c.name}`, message: `its worst legal value has no bound: ${w.unbounded}; give every string a maximum (StoredText) and every list a maximum number of items` })
      else if (w.chars > c.maxChars) out.push({ rule: "stored-value", where: `collection ${c.name}`, message: `its worst legal value takes ${w.chars} characters of JSON, over its maxChars of ${c.maxChars}: a legal value would be refused at write. Raise maxChars or lower the bounds (StoredText counts 2 a character, a plain string 6)` })
    }
    if (storable && definition.storage !== undefined) {
      // The store's own check of the module's whole declaration, on an empty store (what the test household runs).
      const store = makeMemoryHouseholdStore()
      const prepared = yield* Effect.exit(store.prepare([{ id, storage: definition.storage }]))
      const unavailable = store.availability(id)
      const why = prepared._tag === "Failure" ? String(prepared.cause) : unavailable !== undefined ? JSON.stringify(unavailable) : undefined
      if (why !== undefined) {
        out.push({ rule: "collection", where: "storage", message: `the store refuses the module's storage: ${why}` })
        storable = false
      }
    }
    if (options.texts !== undefined) out.push(...textsProblems(options.texts))
    // A collection the store refuses would stop the test household from being made: nothing more can be checked.
    if (!storable) return out

    // Secrets: the given ones, else a recognisable value for every secret field.
    const secretKeys = Object.entries(definition.settings as Record<string, { readonly secret?: boolean }>).filter(([, s]) => s.secret === true).map(([k]) => k)
    const secrets = options.secrets ?? Object.fromEntries(secretKeys.map((k) => [k, SENTINEL(k)]))
    const needles = Object.values(secrets).filter((v) => v.length >= 4)

    const parts: Array<StartedPart> = []
    const harness = yield* startTestModule(definition, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      secrets,
      ...(options.provide !== undefined ? { provide: options.provide } : {}),
      ...(options.others !== undefined ? { others: options.others } : {}),
      ...(options.household !== undefined ? { household: options.household } : {}),
      registrars: [recordParts(parts)]
    })
    const info = harness.info()
    const form = harness.issues().filter((i) => i.id === `${id}.form`)
    for (const i of form) out.push({ rule: "form", where: "settings", message: i.detail })
    if (form.length === 0 && info?.state !== "running") {
      out.push({ rule: "start", where: "start", message: info?.error ?? `it is ${info?.state ?? "missing"}, not running, with these settings and secrets` })
    }
    const mine = parts.filter((p) => p.handle.moduleId === id)
    const tools = mine.flatMap((p) => p.instance?.tools ?? [])
    const actions = mine.flatMap((p) => p.instance?.actions ?? [])
    // Every instance (one per distinct effective settings), each on its own; a problem two share is reported once.
    const reported = new Set(out.map((p) => `${p.rule}\u0000${p.where}\u0000${p.message}`))
    for (const part of mine) {
      if (part.instance === undefined) continue
      for (const p of toolProblems(id, part.instance.tools ?? [], part.instance.actions ?? [])) {
        const key = `${p.rule}\u0000${p.where}\u0000${p.message}`
        if (!reported.has(key)) out.push(p)
        reported.add(key)
      }
    }
    // What it did with the scheduler while it started (the kit's observations of this module only).
    const uses = harness.schedulerUses.filter((u) => u.moduleId === id)
    for (const use of uses) {
      if (use.kind === "handle" && use.part === "instance") {
        out.push({ rule: "scheduler-shared", where: `handler ${use.name}`, message: "register job handlers in shared: an instance runs once per distinct settings, and two handlers of one name refuse the start" })
      }
      // What the real engine refused, in its own words; the check judges nothing again itself.
      if (use.kind === "refused") out.push({ rule: "scheduler-refused", where: `a ${use.call}`, message: `refused (${use.reason}): ${use.message}` })
    }
    // Health: run it once, as "Check again" does (the kit moves the clock past the host's limit if it does not answer).
    const issues = yield* harness.checkHealth
    for (const i of issues) {
      if (i.id === `${id}.health` && /health check (did not finish|failed)/.test(i.title)) {
        out.push({ rule: "health", where: "health()", message: `${i.title}: ${i.detail} (it must answer within 5 s, without failing: return issues instead)` })
      }
    }
    // Secrets in what the module wrote (raw), and in what the host shows after its page boundary ("[secret]"). Values it
    // returns from tools, speaks or stores are for its own tests (`harness.expectNoSecrets`).
    const written: Array<[string, string]> = [
      ...tools.map((t): [string, string] => [`tool ${t.name}`, `${t.name} ${t.description}`]),
      ...actions.map((a): [string, string] => [`action ${a.id}`, `${a.label} ${a.description} ${(a.examples ?? []).join(" ")}`]),
      ...mine.flatMap((p): Array<[string, string]> => [
        ...(p.instance?.instructions !== undefined ? [["instructions", p.instance.instructions] as [string, string]] : []),
        ...(p.instance?.context ?? []).map((c): [string, string] => ["context provider", c.name])
      ])
    ]
    const leaked = new Set<string>()
    for (const [where, text] of written) {
      if (!leaked.has(where) && needles.some((n) => text.includes(n))) {
        leaked.add(where)
        out.push({ rule: "secret", where, message: "it holds a secret's value" })
      }
    }
    const shown = JSON.stringify({ info: harness.info(), issues: harness.issues() })
    if (shown.includes("[secret]") || needles.some((n) => shown.includes(n))) {
      out.push({ rule: "secret", where: "status line, error, form or Health issue", message: "a secret's value reached what the admin page shows (the host's page boundary replaced it with [secret])" })
    }
    return out
  }))

/** Fail (the test) with every rule `definition` breaks, each named with its place. Inside `it.effect`. */
export const checkModule = (definition: ModuleDefinition<any>, options: CheckModuleOptions = {}): Effect.Effect<void, ModuleCheckFailed> =>
  Effect.flatMap(moduleProblems(definition, options), (problems) => (problems.length === 0 ? Effect.void : Effect.fail(new ModuleCheckFailed({ moduleId: definition.id, problems }))))
