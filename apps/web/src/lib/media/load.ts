/** Load a provider's script once: a `<script>` tag, resolved when it fired `load` (rejected on `error` or after `timeoutMs`). */
export type ScriptLoader = (src: string) => Promise<void>

const pending = new Map<string, Promise<void>>()

export const loadScript: ScriptLoader = (src) => {
  const known = pending.get(src)
  if (known !== undefined) return known
  const p = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") return reject(new Error("no document"))
    const el = document.createElement("script")
    el.src = src
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => {
      pending.delete(src) // a later prepare may try again
      reject(new Error(`could not load ${src}`))
    }
    document.head.appendChild(el)
  })
  pending.set(src, p)
  return p
}
