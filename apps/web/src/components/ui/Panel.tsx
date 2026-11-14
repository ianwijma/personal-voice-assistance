"use client"
import { type ReactNode, type RefObject, useEffect, useRef } from "react"

/**
 * Where focus should return when a dialog that replaced another one closes: the first dialog's opener could not take
 * focus at the hand-over (the page behind was still inert), so the second dialog returns focus there instead.
 */
let handOver: HTMLElement | null = null

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Dialog behaviour for panels: focus moves in on open, Tab is trapped inside (unless `trap: false`, for a non-modal
 * panel such as the chat popover on a wide screen), Esc closes (when focus is inside), and focus returns to where it
 * was on close.
 */
export const useDialog = (ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, initialFocus?: string, opts: { readonly trap?: boolean; readonly inertBackground?: boolean } = {}) => {
  const trapRef = useRef(true)
  trapRef.current = opts.trap !== false
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const el = ref.current
    if (el === null) return
    const active = document.activeElement as HTMLElement | null
    const previous = (active === null || active === document.body) && handOver !== null && document.contains(handOver) ? handOver : active
    handOver = null
    // The dialog container can always take focus, so focus never has to stay outside it.
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1
    const usable = (x: HTMLElement) => !(x as HTMLButtonElement).disabled && x.getAttribute("aria-disabled") !== "true" && x.closest("[inert]") === null && (x.offsetParent !== null || x === document.activeElement)
    const enabled = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(usable)
    const wanted = initialFocus !== undefined ? el.querySelector<HTMLElement>(initialFocus) : null
    const first = wanted !== null && usable(wanted) ? wanted : (enabled()[0] ?? el)
    first.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key !== "Tab" || !trapRef.current) return
      const items = enabled()
      const active = document.activeElement
      if (items.length === 0) {
        e.preventDefault()
        el.focus({ preventScroll: true })
        return
      }
      const firstItem = items[0]!
      const lastItem = items[items.length - 1]!
      if (active === null || !el.contains(active) || (active === el && !e.shiftKey)) {
        e.preventDefault()
        firstItem.focus()
      } else if (e.shiftKey && (active === firstItem || active === el)) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && active === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }
    // A modal dialog handles Esc and Tab wherever focus is (focus may have dropped to the body when a control
    // became disabled); a non-modal one only while focus is inside it.
    const modal = trapRef.current
    const target: HTMLElement | Document = modal ? document : el
    target.addEventListener("keydown", onKey as EventListener)
    // A focused control that becomes disabled (a submit in progress) must not take focus out of the dialog.
    const rescue = () => {
      if (!trapRef.current) return
      const active = document.activeElement as HTMLElement | null
      if (active !== null && active !== document.body && el.contains(active) && usable(active)) return
      if (active !== null && active !== document.body && !el.contains(active)) return
      ;(enabled()[0] ?? el).focus({ preventScroll: true })
    }
    // Everything outside the dialog (siblings along its path to <body>) goes inert, except what is marked
    // `data-keep-active` (toasts).
    const made: HTMLElement[] = []
    if (opts.inertBackground === true) {
      for (let node: HTMLElement = el; node.parentElement !== null; node = node.parentElement) {
        for (const sibling of Array.from(node.parentElement.children)) {
          if (sibling === node || !(sibling instanceof HTMLElement) || sibling.hasAttribute("data-keep-active") || sibling.inert) continue
          sibling.inert = true
          made.push(sibling)
        }
      }
    }
    const observer = new MutationObserver(rescue)
    observer.observe(el, { attributes: true, attributeFilter: ["disabled", "aria-disabled"], subtree: true })
    return () => {
      target.removeEventListener("keydown", onKey as EventListener)
      observer.disconnect()
      for (const x of made) x.inert = false
      if (previous !== null && document.contains(previous)) {
        previous.focus({ preventScroll: true })
        if (document.activeElement !== previous) handOver = previous
      }
    }
  }, [open, ref, initialFocus])
}

export function PanelHeader({ title, titleId, onClose, children }: { readonly title: string; readonly titleId: string; readonly onClose: () => void; readonly children?: ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line pl-5 pr-2">
      <h2 id={titleId} className="label text-ink-muted">{title}</h2>
      <div className="ml-auto flex items-center gap-1">
        {children}
        <button
          type="button"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onClose}
          className="inline-flex size-11 items-center justify-center rounded-md text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
          </svg>
        </button>
      </div>
    </div>
  )
}
