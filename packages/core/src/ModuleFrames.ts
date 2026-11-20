/**
 * What one module takes on the admin page's WebSocket (P3, review round 6). Every frame is at most
 * `MAX_TEXT_FRAME_BYTES` (1 MiB). Two rules keep every module within it, whatever its projection holds:
 *
 * - **One module, one frame** (`withinModuleFrame`): a module's complete projection (`ModuleInfo`: its form, tools,
 *   routes, instances, templates, texts) as one `module.changed` message is at most `MODULE_FRAME_MAX_BYTES`. Each
 *   kind is bounded on its own already (the complete form 48 KiB, `MODULE_FORM_MAX_BYTES`; at most 100 listed tools
 *   with short descriptions inside the same 48 KiB; at most 32 routes of bounded paths and descriptions; one instance
 *   per assistant at most, with bounded texts; the templates' share); this is the one final guard on what they make
 *   together, measured on the encoded message. Over it, the projection is shortened in a fixed order until it fits:
 *   the listed routes (the page lists them all from the admin route API), the listed tools ("and N more",
 *   `toolsLeft`), the instances' texts (cut, "…"), and last the form (replaced by the error that names its largest
 *   field).
 * - **What does not fit the snapshot follows it** (`adminModules`): `admin.snapshot` carries each module's complete
 *   projection while the modules together stay within `ADMIN_MODULES_SHARE_BYTES`, measured on the encoded
 *   projections. A module that does not fit is sent in the snapshot as a light entry (`lightModule`: identity,
 *   switch, state and its short error, `details: "follow"`), and its complete projection follows at once in its own
 *   `module.changed` frame, in the same send. Nothing is withheld because of other modules.
 */
import { encodeServerMessage, ModuleInfo, type SettingsForm } from "@pva/protocol"
import { Result, Schema } from "effect"

/**
 * The share of one `admin.snapshot` frame (1 MiB) that the modules' projections take together, encoded (their forms,
 * tools, routes, instances, templates and texts): it leaves 576 KiB for the Health issues (256 KiB) and everything
 * else. A module that does not fit is a light entry there, and its complete projection follows in its own frame.
 */
export const ADMIN_MODULES_SHARE_BYTES = 448 * 1024

/**
 * One `module.changed` message at most, encoded (UTF-8 bytes): a quarter of the frame. What the per-kind bounds allow
 * together stays far under the frame even before this guard; the guard makes the bound one number.
 */
export const MODULE_FRAME_MAX_BYTES = 256 * 1024

/** A light entry's description and error, at most (characters). */
const LIGHT_TEXT = 300
/** An instance's error when the frame guard shortens the instances' texts (characters). */
const SHORT_INSTANCE_ERROR = 200

const utf8 = new TextEncoder()
export const jsonBytes = (value: unknown): number => utf8.encode(JSON.stringify(value)).length

/** `n`, moved back so that `text.slice(0, n)` does not end in half a character (a lone high surrogate). */
export const wholeCodePoints = (text: string, n: number): number => {
  const c = n > 0 && n < text.length ? text.charCodeAt(n - 1) : 0
  return c >= 0xd800 && c <= 0xdbff ? n - 1 : n
}
/** At most `max` characters, the last one "…" when it was cut, never half a character. */
export const clipText = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, wholeCodePoints(text, max - 1))}…`)

const kib = (bytes: number) => Math.ceil(bytes / 1024)

/** The field of a form whose value (or, without values, whose description) takes the most, as `{ key, label }`. */
export const largestField = (form: SettingsForm): { readonly key: string | null; readonly label: string } => {
  let best: { key: string; bytes: number } | undefined
  for (const [key, value] of Object.entries(form.values)) {
    const bytes = jsonBytes(value)
    if (best === undefined || bytes > best.bytes) best = { key, bytes }
  }
  for (const field of form.fields) {
    const bytes = jsonBytes(field)
    if (best === undefined || bytes > best.bytes) best = { key: field.key, bytes }
  }
  if (best === undefined) return { key: null, label: "its messages" }
  const key = best.key
  const label = form.fields.find((f) => f.key === key)?.label ?? key
  return { key, label: clipText(label.replace(/\s+/g, " "), 100) }
}

const encodeModule = Schema.encodeUnknownResult(ModuleInfo)

/** A module's projection as the wire encodes it (UTF-8 bytes of its JSON inside a snapshot). */
export const moduleBytes = (m: ModuleInfo): number => {
  const encoded = encodeModule(m)
  return jsonBytes(Result.isSuccess(encoded) ? encoded.success : m)
}

/** The whole `module.changed` message of this projection, encoded (UTF-8 bytes). */
const frameBytes = (m: ModuleInfo): number => {
  try {
    return utf8.encode(encodeServerMessage({ type: "module.changed", module: m })).length
  } catch {
    // Not valid for the wire: sending it would fail the same way; measured as JSON so the guard still bounds it.
    return jsonBytes({ type: "module.changed", module: m })
  }
}

/** How many of `items` (from the end) to leave out so that `size` drops by at least `excess` (each item and its comma). */
const toLeaveOut = (items: ReadonlyArray<unknown>, excess: number): number => {
  let saved = 0
  let n = 0
  while (n < items.length && saved < excess) {
    saved += jsonBytes(items[items.length - 1 - n]) + 1
    n++
  }
  return n
}

/**
 * The final guard on one module's projection, where `module.changed` is built (and the snapshot's entries, which
 * are the same projections): its encoded message at most `MODULE_FRAME_MAX_BYTES`. Over it, shortened in this order
 * until it fits, each step visible on the page:
 *
 * 1. the listed routes, the last first (the page's route list reads them all from `GET /api/module-routes`);
 * 2. the listed tools, the last first, counted in `toolsLeft` ("and N more");
 * 3. the instances' texts: each error cut to 200 characters ("…");
 * 4. the form: replaced by one error naming its largest field (the module keeps running; nothing saved changes).
 *
 * What remains after step 4 (the identity, the templates within their 128 KiB share, the instances' assistants and
 * own field names) is bounded too, far under the 1 MiB frame.
 */
export const withinModuleFrame = (m: ModuleInfo): ModuleInfo => {
  let out = m
  let bytes = frameBytes(out)
  if (bytes <= MODULE_FRAME_MAX_BYTES) return m
  const routes = out.routes ?? []
  if (routes.length > 0) {
    const n = toLeaveOut(routes, bytes - MODULE_FRAME_MAX_BYTES)
    const { routes: _all, ...rest } = out
    out = n >= routes.length ? rest : { ...rest, routes: routes.slice(0, routes.length - n) }
    bytes = frameBytes(out)
    if (bytes <= MODULE_FRAME_MAX_BYTES) return out
  }
  if (out.tools.length > 0) {
    const n = toLeaveOut(out.tools, bytes - MODULE_FRAME_MAX_BYTES)
    out = { ...out, tools: out.tools.slice(0, out.tools.length - n), toolsLeft: (out.toolsLeft ?? 0) + n }
    bytes = frameBytes(out)
    if (bytes <= MODULE_FRAME_MAX_BYTES) return out
  }
  if (out.instances !== undefined && out.instances.some((i) => i.error !== undefined && i.error.length > SHORT_INSTANCE_ERROR)) {
    out = { ...out, instances: out.instances.map((i) => (i.error === undefined ? i : { ...i, error: clipText(i.error, SHORT_INSTANCE_ERROR) })) }
    bytes = frameBytes(out)
    if (bytes <= MODULE_FRAME_MAX_BYTES) return out
  }
  const largest = largestField(out.settings)
  const message = clipText(
    `${out.name}'s settings are not shown: with everything else this module shows, its page is more than one message to the admin page can carry (${kib(bytes)} KiB; at most ${kib(MODULE_FRAME_MAX_BYTES)} KiB). The largest field is "${largest.label}": reduce it in the settings file.`,
    2000
  )
  return { ...out, settings: { fields: [], values: {}, secrets: {}, errors: [{ key: null, message }] } }
}

/**
 * A module as the snapshot carries it when its complete projection does not fit there: identity, switch, state and
 * its short error, marked `details: "follow"` (its complete projection follows at once in `module.changed`).
 */
export const lightModule = (m: ModuleInfo): ModuleInfo => ({
  id: m.id,
  name: m.name,
  description: clipText(m.description, LIGHT_TEXT),
  enabled: m.enabled,
  state: m.state,
  ...(m.error !== undefined ? { error: clipText(m.error, LIGHT_TEXT) } : {}),
  tools: [],
  settings: { fields: [], values: {}, secrets: {}, errors: [] },
  revision: m.revision,
  ...(m.protected !== undefined ? { protected: m.protected } : {}),
  ...(m.kind !== undefined ? { kind: m.kind } : {}),
  ...(m.group !== undefined ? { group: m.group } : {}),
  ...(m.unavailable !== undefined ? { unavailable: m.unavailable } : {}),
  details: "follow"
})

/**
 * The modules of one `admin.snapshot` (`modules`) and the complete projections to send right after it, each in its
 * own `module.changed` (`follow`), in catalogue order. Every module is complete in the snapshot while the modules
 * together (with a light entry's room kept for each that follows) stay within `ADMIN_MODULES_SHARE_BYTES`, measured
 * on their encoded projections; the others are light entries there. Pass projections already within their frame
 * (`withinModuleFrame`).
 */
export const adminModules = (all: ReadonlyArray<ModuleInfo>): { readonly modules: Array<ModuleInfo>; readonly follow: Array<ModuleInfo> } => {
  const light = all.map(lightModule)
  const lightSize = light.map(moduleBytes)
  // Room for the complete projections once every module's light entry (and its comma) is counted.
  let room = ADMIN_MODULES_SHARE_BYTES - lightSize.reduce((sum, n) => sum + n + 1, 0)
  const modules: Array<ModuleInfo> = []
  const follow: Array<ModuleInfo> = []
  all.forEach((m, i) => {
    const extra = moduleBytes(m) - lightSize[i]!
    if (extra <= room) {
      room -= extra
      modules.push(m)
    } else {
      modules.push(light[i]!)
      follow.push(m)
    }
  })
  return { modules, follow }
}
