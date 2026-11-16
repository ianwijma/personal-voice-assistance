"use client"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { Icon } from "../ui/Icon.tsx"
import { cx } from "../ui/controls.tsx"

export interface PopMenuItem {
  readonly value: string
  readonly title: string
  readonly detail: string
  readonly checked: boolean
  /** A separator goes above this item. */
  readonly separator?: boolean
  readonly testId?: string
}

/**
 * A button with a menu of radio items under it (docs/mockups/assistants/voice.html): the assistant menu in the top bar
 * and the conversation switcher in the chat. Arrow keys move, Home and End jump, Esc and Tab close (Esc gives the
 * focus back to the button), a click outside closes it, and focus goes to the checked item when it opens.
 */
export function PopMenu({
  label,
  menuLabel,
  note,
  items,
  onPick,
  triggerClass,
  menuClass,
  title,
  testId,
  children
}: {
  readonly label: string
  readonly menuLabel: string
  readonly note: string
  readonly items: ReadonlyArray<PopMenuItem>
  readonly onPick: (value: string) => void
  readonly triggerClass: string
  readonly menuClass?: string
  readonly title: string
  readonly testId: string
  /** The trigger's content (the text and the chevron are added after it). */
  readonly children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const focusItem = (i: number) => menu.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]")[i]?.focus()
  const close = (focusTrigger: boolean) => {
    setOpen(false)
    if (focusTrigger) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const checked = items.findIndex((x) => x.checked)
    focusItem(Math.max(0, checked))
    const outside = (e: PointerEvent) => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", outside, true) // continuation(none): only closes this menu
    // Esc closes the menu and nothing around it (a dialog's own listener, on an element above, would close the dialog):
    // a native listener on the menu runs before those, which a React handler would not.
    const el = menu.current
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    el?.addEventListener("keydown", escape) // continuation(none): only closes this menu
    return () => {
      document.removeEventListener("pointerdown", outside, true)
      el?.removeEventListener("keydown", escape)
    }
    // Focus moves in once, when the menu opens.
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent) => {
    const all = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])
    const i = all.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      all[(n + all.length) % all.length]?.focus()
    }
    if (e.key === "ArrowDown") go(i + 1)
    else if (e.key === "ArrowUp") go(i - 1)
    else if (e.key === "Home") go(0)
    else if (e.key === "End") go(all.length - 1)
    else if (e.key === "Tab") close(true)
  }

  return (
    <div ref={wrap} className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={title}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className={cx("group/trigger inline-flex items-center gap-1.5 rounded-md transition-colors duration-[120ms] ease-out hover:bg-surface-2", open && "bg-surface-2", triggerClass)}
      >
        {children}
        <span className="label max-w-[40vw] truncate">{label}</span>
        <Icon name="chevronDown" size={12} className={cx("shrink-0 text-ink-faint transition-transform duration-[120ms]", open && "rotate-180")} />
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={menuLabel}
          data-testid={`${testId}-menu`}
          onKeyDown={onMenuKey}
          className={cx(
            "absolute left-0 top-[calc(100%+6px)] z-50 w-[296px] max-w-[calc(100vw-24px)] rounded-lg border border-line bg-surface p-1 shadow-panel animate-[pva-rise_160ms_var(--ease-out)]",
            menuClass
          )}
        >
          {items.map((item) => (
            <div key={item.value}>
              {item.separator === true && <div role="separator" className="mx-1.5 my-1 h-px bg-line/60" />}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={item.checked}
                tabIndex={-1}
                data-testid={item.testId}
                data-value={item.value}
                onClick={() => {
                  setOpen(false)
                  trigger.current?.focus()
                  onPick(item.value)
                }}
                className="flex min-h-[52px] w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-offset-[-2px]"
              >
                <span className="inline-flex h-5 w-4 shrink-0 items-center justify-center text-you">{item.checked && <Icon name="check" size={16} />}</span>
                <span className="min-w-0">
                  <span className="block text-[14px] text-ink">{item.title}</span>
                  <span className="block text-[13px] text-ink-muted">{item.detail}</span>
                </span>
              </button>
            </div>
          ))}
          <p className="px-2.5 pb-2 pt-1.5 pl-9 text-[12px] text-ink-faint">{note}</p>
        </div>
      )}
    </div>
  )
}
