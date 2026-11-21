/** Copy `text`; over plain http (no clipboard API) through a selected text field. */
export const copyText = async (text: string, host: HTMLElement | null): Promise<boolean> => {
  try {
    if (window.isSecureContext && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text) // continuation(none): the caller only shows "Copied"
      return true
    }
  } catch {
    // fall back below
  }
  if (host === null) return false
  const field = document.createElement("textarea")
  field.value = text
  field.setAttribute("readonly", "")
  field.style.position = "fixed"
  field.style.opacity = "0"
  host.appendChild(field)
  field.select()
  let ok = false
  try {
    ok = document.execCommand("copy")
  } catch {
    ok = false
  }
  field.remove()
  return ok
}
