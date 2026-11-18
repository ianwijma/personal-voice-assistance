/**
 * The conformance check every module's test calls (docs/MODULES.md, "Testing: checkModule"):
 * `yield* checkModule(definition, { settings? })` starts the module in the real host through the test kit
 * (`startTestModule`) and fails, naming each rule and the place, for what the docs state as a rule a module can break
 * without noticing. `moduleProblems` answers the list instead of failing. Exported from `@pva/core/testing` only.
 *
 * The rules (`ModuleProblem.rule`):
 *
 * | rule | what fails |
 * |---|---|
 * | `api-version` | the module does not declare `apiVersion: 2` |
 * | `off-by-default` | a new module is on before the owner chose (`enabledByDefault` not `false`) |
 * | `form` | its described settings form does not encode with the wire's schema or exceeds its budget |
 * | `start` | it does not start in the real host with the given settings and secrets |
 * | `secret` | a secret's value appears in a status line, an error, a form, a Health issue, a tool's name or description, an action's text, instructions, a route or a context provider's name |
 * | `risk` | a tool or action that is not a plain read (`speculative: true`) declares no risk class |
 * | `risk-said` | one that can be `money` or `security` does not say so in its description |
 * | `tool-name` | a tool's name, or an action's generated tool name `<moduleId>_<actionId>`, is not 1–64 of `[A-Za-z0-9_-]`, or a name is used twice |
 * | `tool-description` | a tool's description is empty or over 1,024 characters |
 * | `tool-parameters` | a tool's parameters are not a JSON object schema, or name a property outside 1–64 of `[A-Za-z0-9_.-]` |
 * | `action-examples` | an action declares no `examples` (the keyword decider and the model have nothing to match) |
 * | `stored-value` | a collection's worst legal value is longer than its `maxChars` (or unbounded: a string or list without a maximum) |
 * | `scheduler-shared` | a scheduler handler is registered in an instance's `start` instead of `shared` |
 * | `cron` | a cron expression it scheduled is outside the accepted grammar (refused by the real engine) |
 * | `job-payload` | a job it scheduled has a payload its handler's schema does not decode (every run of it would fail) |
 * | `health` | it requires the network but declares no `health`, or its `health()` fails, dies or does not answer in time |
 * | `texts` | the spoken texts it declares (`options.texts`) differ between English and Dutch in keys or placeholders, or one is empty or not one line |
 */
import { Data, Effect, Exit, Schema } from "effect"
import type { Collection } from "./HouseholdStore.ts"
import type { ModuleDefinition } from "./ModuleDefinition.ts"
import type { StartedPart } from "./ModuleRegistrations.ts"
import { toolMetadata, type Tool } from "./Module.ts"
import { actionToolName, type ActionDefinition } from "./Actions.ts"
import { recordParts, startTestModule, type StartTestModuleOptions } from "./ModuleTestKit.ts"

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

/** The longest JSON text of a JavaScript number (`-1.7976931348623157e+308`). */
const NUMBER_CHARS = 24

type Worst = { readonly chars: number } | { readonly unbounded: string }

/**
 * The most characters of JSON a value of this JSON Schema can take (`JSON.stringify`, the store's `maxChars`
 * measure), or the path of the first part that has no bound. Every optional field is counted as present; a string
 * costs 6 characters of JSON per UTF-16 unit (a control character's `\u0000` escape), 2 when it is a `StoredText`;
 * a number 24 (an integer between bounds, the longer bound).
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

// ---------------------------------------------------------------------------------------------------------------------
// The check

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_TOOL_DESCRIPTION = 1_024
const SENTINEL = (key: string) => `pva-check-secret-${key}-7d1f`
const PLACEHOLDERS = (text: string) => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!).sort()

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
      if (/[\u0000-\u001f]/.test(t)) out.push({ rule: "texts", where: `text "${key}"`, message: `the ${lang} text is not one line` })
    }
    if (PLACEHOLDERS(en).join(",") !== PLACEHOLDERS(nl).join(",")) {
      out.push({ rule: "texts", where: `text "${key}"`, message: `its placeholders differ: {${PLACEHOLDERS(en).join("}, {")}} in English, {${PLACEHOLDERS(nl).join("}, {")}} in Dutch` })
    }
  }
  return out
}

const toolProblems = (moduleId: string, tools: ReadonlyArray<Tool>, actions: ReadonlyArray<ActionDefinition<any>>): Array<ModuleProblem> => {
  const out: Array<ModuleProblem> = []
  const seen = new Set<string>()
  const riskSaid = (where: string, description: string, meta: Parameters<typeof toolMetadata>[0]) => {
    for (const c of toolMetadata(meta).risks) {
      if ((c === "money" || c === "security") && !description.toLowerCase().includes(c)) {
        out.push({ rule: "risk-said", where, message: `it can be "${c}" (refused in this stack), and its description does not say "${c}"` })
      }
    }
  }
  for (const tool of tools) {
    const where = `tool ${tool.name}`
    if (!TOOL_NAME.test(tool.name)) out.push({ rule: "tool-name", where, message: "a tool name is 1–64 of A–Z, a–z, 0–9, _ and - (what Anthropic and OpenAI accept)" })
    if (seen.has(tool.name)) out.push({ rule: "tool-name", where, message: "the name is used twice" })
    seen.add(tool.name)
    if (tool.description.trim() === "" || tool.description.length > MAX_TOOL_DESCRIPTION) {
      out.push({ rule: "tool-description", where, message: `a description is 1 to ${MAX_TOOL_DESCRIPTION} characters (it has ${tool.description.length})` })
    }
    if (tool.risk === undefined && tool.speculative !== true) {
      out.push({ rule: "risk", where, message: "it is not a plain read (speculative: true) and declares no risk: declare risk: \"change\" (or the class it is)" })
    }
    riskSaid(where, tool.description, tool)
    try {
      const doc = Schema.toJsonSchemaDocument(tool.parameters)
      const top = doc.schema as Record<string, unknown>
      // `Schema.Struct({})` (no parameters) has the JSON Schema `{ not: { type: "null" } }`: accepted as the empty object.
      const emptyStruct = JSON.stringify(top) === JSON.stringify({ not: { type: "null" } })
      if (top.type !== "object" && !emptyStruct) out.push({ rule: "tool-parameters", where, message: "its parameters must be an object (a Schema.Struct): model providers take only an object as a tool's input" })
      for (const name of Object.keys((top.properties ?? {}) as object)) {
        if (!PROPERTY_NAME.test(name)) out.push({ rule: "tool-parameters", where, message: `the parameter "${name}" is not 1–64 of A–Z, a–z, 0–9, _ . and -` })
      }
    } catch (e) {
      out.push({ rule: "tool-parameters", where, message: `its parameters have no JSON Schema (${e instanceof Error ? e.message : String(e)})` })
    }
  }
  for (const action of actions) {
    const name = `${moduleId}_${action.id}`
    const where = `action ${action.id}`
    if (name.length > 64 || actionToolName(moduleId, action.id) !== name) {
      out.push({ rule: "tool-name", where, message: `its generated tool name "${name}" is over 64 characters (it would be cut): shorten the action id` })
    }
    if (action.offerAsTool !== false) {
      if (seen.has(name)) out.push({ rule: "tool-name", where, message: `its generated tool name "${name}" is also a tool's name` })
      seen.add(name)
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
    for (const c of definition.storage?.collections ?? []) {
      const w = collectionWorst(c)
      if ("unbounded" in w) out.push({ rule: "stored-value", where: `collection ${c.name}`, message: `its worst legal value has no bound: ${w.unbounded}; give every string a maximum (StoredText) and every list a maximum number of items` })
      else if (w.chars > c.maxChars) out.push({ rule: "stored-value", where: `collection ${c.name}`, message: `its worst legal value takes ${w.chars} characters of JSON, over its maxChars of ${c.maxChars}: a legal value would be refused at write. Raise maxChars or lower the bounds (StoredText counts 2 a character, a plain string 6)` })
    }
    if (options.texts !== undefined) out.push(...textsProblems(options.texts))

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
    // One instance per distinct settings: the same tools appear once per instance; check each name once.
    const firstInstance = mine.find((p) => p.instance !== undefined)?.instance
    out.push(...toolProblems(id, firstInstance?.tools ?? [], firstInstance?.actions ?? []))
    for (const use of harness.schedulerUses) {
      if (use.kind === "handle" && use.part === "instance") {
        out.push({ rule: "scheduler-shared", where: `handler ${use.name}`, message: "register job handlers in shared: an instance runs once per distinct settings, and two handlers of one name refuse the start" })
      }
      if (use.kind === "refused" && use.cron !== undefined) out.push({ rule: "cron", where: `cron "${use.cron}"`, message: use.message })
      if (use.kind === "scheduled") {
        const handler = harness.schedulerUses.find((u) => u.kind === "handle" && u.name === use.handler)
        if (handler?.kind === "handle" && Exit.isFailure(Schema.decodeUnknownExit(Schema.toCodecJson(handler.payload))(use.payload))) {
          out.push({ rule: "job-payload", where: `job of ${use.handler}`, message: `its payload ${JSON.stringify(use.payload)?.slice(0, 80)} does not decode with the handler's payload schema, so every run fails (an absent payload is null: pass payload: {} for Schema.Struct({}))` })
        }
      }
    }
    // Health: run it once, as "Check again" does.
    const issues = yield* harness.checkHealth
    for (const i of issues) {
      if (i.id === `${id}.health` && /health check (did not finish|failed)/.test(i.title)) {
        out.push({ rule: "health", where: "health()", message: `${i.title}: ${i.detail} (it must answer within 5 s, without failing: return issues instead)` })
      }
    }
    // Secrets in what the module wrote (raw), and in what the host shows after its page boundary ("[secret]").
    const routes = mine.flatMap((p) => p.shared?.routes ?? [])
    const written: Array<[string, string]> = [
      ...tools.map((t): [string, string] => [`tool ${t.name}`, `${t.name} ${t.description}`]),
      ...actions.map((a): [string, string] => [`action ${a.id}`, `${a.label} ${a.description} ${(a.examples ?? []).join(" ")}`]),
      ...mine.flatMap((p): Array<[string, string]> => [
        ...(p.instance?.instructions !== undefined ? [["instructions", p.instance.instructions] as [string, string]] : []),
        ...(p.instance?.context ?? []).map((c): [string, string] => ["context provider", c.name])
      ]),
      ...routes.map((r): [string, string] => [`route ${r.method} ${r.path}`, `${r.path} ${r.description ?? ""} ${r.token ?? ""}`])
    ]
    for (const [where, text] of written) {
      if (needles.some((n) => text.includes(n))) out.push({ rule: "secret", where, message: "it holds a secret's value" })
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
