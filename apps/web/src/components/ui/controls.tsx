"use client"
import type { ButtonHTMLAttributes, ReactNode } from "react"

const cx = (...xs: ReadonlyArray<string | false | null | undefined>) => xs.filter(Boolean).join(" ")
export { cx }

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "default" | "primary" | "quiet" | "danger"
  readonly size?: "sm" | "md"
}

/** 40 px, 44 px on a phone (32 px small, with a 44 px hit area on a phone) rectangular buttons: 1 px line border on surface; primary = voice outline. */
export function Button({ variant = "default", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap",
        "transition-[background-color,border-color,color,opacity] duration-[120ms] ease-out",
        "disabled:cursor-not-allowed disabled:opacity-45",
        // Small buttons keep their 32 px look; on a phone a padded hit area makes them 44 px tall.
        size === "md" ? "h-10 px-4 text-[14px] max-sm:h-11" : "relative h-8 px-3 text-[13px] max-sm:before:absolute max-sm:before:inset-x-0 max-sm:before:-inset-y-[7px] max-sm:before:content-['']",
        variant === "default" && "border-line bg-surface text-ink hover:bg-surface-2 enabled:active:bg-surface-2",
        variant === "primary" && "border-voice/70 bg-transparent text-voice hover:bg-voice-soft hover:border-voice",
        variant === "quiet" && "border-transparent bg-transparent text-ink-muted hover:text-ink hover:bg-surface-2",
        variant === "danger" && "border-danger/50 bg-transparent text-danger hover:bg-danger/10",
        className
      )}
      {...rest}
    />
  )
}

export function IconButton({ label, className, children, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { readonly label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-10 items-center justify-center rounded-md text-ink-muted",
        "transition-colors duration-[120ms] ease-out hover:bg-surface-2 hover:text-ink disabled:opacity-40",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  busy = false,
  id,
  describedBy
}: {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly disabled?: boolean
  readonly busy?: boolean
  readonly id?: string
  readonly describedBy?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        // 24 × 40 to look at; the ::before (offsets from the padding box, inside the 1 px border) makes the hit area 44 × 50.
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-[120ms] ease-out",
        "before:absolute before:-inset-x-[5px] before:-inset-y-[11px] before:content-['']",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // State is carried by the thumb (≥ 3:1 against its track in both themes, test/contrast.test.ts) and its side;
        // the checked track's edge is full mint.
        checked ? "border-you bg-you-soft" : "border-line bg-surface-2"
      )}
    >
      <span
        className={cx(
          "absolute top-1/2 size-4 -translate-y-1/2 rounded-full transition-[left,background-color] duration-[160ms] ease-out",
          checked ? "left-[19px] bg-you" : "left-[3px] bg-ink-faint",
          busy && "animate-pulse"
        )}
      />
    </button>
  )
}

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  name,
  tall = false,
  testId
}: {
  readonly value: V
  readonly options: ReadonlyArray<{ readonly value: V; readonly label: ReactNode }>
  readonly onChange: (value: V) => void
  readonly label: string
  readonly disabled?: boolean
  readonly name: string
  /** 40 px options, for touch-first places such as the voice sheet. (Every segmented control is 44 px on a phone.) */
  readonly tall?: boolean
  readonly testId?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className="flex w-full rounded-md border border-line bg-surface-2/60 p-0.5">
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            name={name}
            aria-checked={selected}
            data-value={o.value}
            disabled={disabled}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
              e.preventDefault()
              const i = options.findIndex((x) => x.value === value)
              const next = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length]!
              onChange(next.value)
              const group = e.currentTarget.parentElement
              requestAnimationFrame(() => (group?.querySelector<HTMLButtonElement>("[aria-checked=true]"))?.focus())
            }}
            onClick={() => onChange(o.value)}
            className={cx(
              "flex-1 rounded-[5px] px-2.5 py-1 text-[13px] leading-tight transition-colors duration-[120ms] ease-out",
              tall ? "min-h-10 max-sm:min-h-11" : "min-h-8 max-sm:min-h-11",
              "disabled:cursor-not-allowed",
              // The selected segment: a solid 2 px ink-muted edge (≥ 3:1 against the selected surface and the group's
              // background in both themes, test/contrast.test.ts), unlike the mint focus ring outside it.
              selected ? "bg-surface font-medium text-ink shadow-[inset_0_0_0_2px_var(--color-ink-muted)]" : "text-ink-muted hover:text-ink"
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Label({ children, className, as: As = "span", ...rest }: { readonly children: ReactNode; readonly className?: string; readonly as?: "span" | "h2" | "h3" | "div" } & { readonly id?: string }) {
  return <As className={cx("label", className)} {...rest}>{children}</As>
}

/** Tone dot + text, for module status lines and connection state. */
export function ToneDot({ tone, className }: { readonly tone: "ok" | "warning" | "error" | "neutral"; readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-block size-1.5 shrink-0 rounded-full",
        tone === "ok" && "bg-ok",
        tone === "warning" && "bg-warn",
        tone === "error" && "bg-danger",
        tone === "neutral" && "bg-ink-faint",
        className
      )}
    />
  )
}
