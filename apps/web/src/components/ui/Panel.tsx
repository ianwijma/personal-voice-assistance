"use client"
import { type ReactNode, type RefObject, useEffect, useRef } from "react"

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Dialog behaviour for panels: focus moves in on open, Tab is trapped inside,
 * Esc closes (when focus is inside), and focus returns to where it was on close.
 */
export const useDialog = (ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, initialFocus?: string) => {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const el = ref.current
    if (el === null) return
    const previous = document.activeElement as HTMLElement | null
    const first = (initialFocus !== undefined ? el.querySelector<HTMLElement>(initialFocus) : null) ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el
    first.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key !== "Tab") return
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement)
      if (items.length === 0) return
      const firstItem = items[0]!
      const lastItem = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }
    el.addEventListener("keydown", onKey)
    return () => {
      el.removeEventListener("keydown", onKey)
      if (previous !== null && document.contains(previous)) previous.focus({ preventScroll: true })
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
          className="inline-flex size-10 items-center justify-center rounded-md text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
          </svg>
        </button>
      </div>
    </div>
  )
}
