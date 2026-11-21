import type { FieldActionResult, HostResult, ModuleHost } from "@pva/core"
import type { ClientMessageOf } from "@pva/protocol"
import { Effect } from "effect"

/** P3: what `module.action` answers: the handler's result on a successful `result`, or a refusal. */
export type ActionOutcome = { readonly ok: true; readonly action: FieldActionResult } | Extract<HostResult, { readonly ok: false }>

/** Press a module's `action` field for a page (docs/UI-AND-MODULES.md §1.7). */
export const moduleActionOutcome = (host: ModuleHost, message: ClientMessageOf<"module.action">): Effect.Effect<ActionOutcome> =>
  Effect.map(host.fieldAction(message.moduleId, message.key, message.values), (r): ActionOutcome =>
    r.ok
      ? { ok: true, action: { ok: r.result.ok, text: r.result.text, ...(r.result.tone !== undefined ? { tone: r.result.tone } : {}), ...(r.result.link !== undefined ? { link: r.result.link } : {}) } }
      : { ok: false, error: { code: r.code, message: r.message, moduleId: message.moduleId } })
