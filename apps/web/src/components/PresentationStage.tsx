"use client"
import type { PresentContent, WeatherIcon } from "@pva/protocol"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { formatRemaining, remainingMs } from "@/lib/countdown.ts"
import { type HeldPresentation, pageClock } from "@/lib/state.ts"
import { useClient, useClientState } from "./context.tsx"
import { NotificationCards } from "./NotificationCards.tsx"
import { cx } from "./ui/controls.tsx"

/**
 * P10: the presentation stage (docs/PRESENTING.md "The voice page"; docs/CHARACTERS.md §2.7). One layout on every
 * character: a column centred under the character's box, just above the controls, that grows upward as far as it may
 * without covering the box (at least 160 px on a short screen) and scrolls within itself beyond that. The character's
 * box, its canvas and the focus it is given are exactly as before:
 * the stage only adds bottom padding to the page's scroll area (`--pva-present-h`) so captions can scroll clear of it.
 *
 * It holds the notification cards first (P9, unchanged: `NotificationCards`), then the presentations, a transient one
 * first, then the pinned ones. Open page menus and dialogs hide ordinary presentations and render notification cards
 * inside their own surface instead. Every word the host shows comes from the server in the household's language
 * (`texts`); every text of a presentation passed the server's page boundary and is put on the page as text, never as
 * markup. An image is only ever `/media/<token>`, the server's copy.
 */
export function PresentationStage({ obscured = false }: { readonly obscured?: boolean }) {
  const shownCards = useClientState((s) => s.notifications.some((c) => c.show))
  const items = useClientState((s) => s.presentations)
  const chatOpen = useClientState((s) => s.ui.chatOpen)
  const inner = useRef<HTMLDivElement>(null)
  const empty = !shownCards && items.length === 0
  // The stage's scroll area keeps the region's height clear at its bottom (captions scroll above it).
  useLayoutEffect(() => {
    const root = typeof document === "undefined" ? undefined : document.documentElement
    const el = inner.current
    if (root === undefined) return
    if (el === null || empty) {
      root.style.setProperty("--pva-present-h", "0px")
      return
    }
    const set = () => root.style.setProperty("--pva-present-h", `${Math.ceil(el.getBoundingClientRect().height)}px`)
    set()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.setProperty("--pva-present-h", "0px")
    }
  }, [empty, obscured])
  if (empty) return null
  const ordered = [...items.filter((p) => p.lifetime === "transient"), ...items.filter((p) => p.lifetime === "pinned").sort((a, b) => a.shownAt - b.shownAt)]
  return (
    <div
      data-testid="present-stage"
      className={cx(
        "pointer-events-none fixed inset-x-0 bottom-[calc(96px+env(safe-area-inset-bottom))] z-[5] flex justify-center px-4 transition-transform duration-[320ms] ease-out",
        chatOpen && "lg:max-[1439px]:-translate-x-[200px]"
      )}
    >
      <div
        ref={inner}
        className="pointer-events-auto flex max-h-[max(160px,min(42dvh,calc(100dvh-540px)))] w-full max-w-[420px] flex-col gap-2 overflow-y-auto overscroll-contain scrollbar-quiet pt-1"
      >
        {/* An open menu or dialog owns these controls, including its keyboard scope. */}
        {!obscured ? <NotificationCards /> : null}
        {ordered.length > 0
          ? (
            <section
              aria-label={ordered[0]!.texts.region}
              data-testid="presentations"
              hidden={obscured}
              inert={obscured}
              className={cx("w-full flex-col gap-2", obscured ? "hidden" : "flex")}
            >
              {ordered.map((p) => <PresentationCard key={`${p.id}:${p.revision}`} p={p} />)}
            </section>
          )
          : null}
      </div>
    </div>
  )
}

/** One presentation: its kind's renderer, its buttons, and the answer to the last press while it is still held. */
function PresentationCard({ p }: { readonly p: HeldPresentation }) {
  const client = useClient()
  const [said, setSaid] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  /** A tick or a button: one request each; the answer is shown only while this presentation is still held here. */
  const press = (key: string, message: { readonly action: string; readonly item?: string; readonly done?: boolean }) => {
    if (!p.interactive || pending.has(key)) return
    setPending((x) => new Set(x).add(key))
    const current = () => mounted.current && client.store.get().presentations.some((x) => x.id === p.id && x.revision === p.revision)
    const done = () => {
      if (!mounted.current) return
      setPending((x) => {
        const next = new Set(x)
        next.delete(key)
        return next
      })
    }
    // continuation(identity): shows this presentation's own answer, only while it is still held.
    void client.request({ type: "present.action", id: p.id, revision: p.revision, ...message }).then((r) => {
      done()
      if (current()) setSaid(r.say ?? (r.ok ? undefined : p.texts.failed))
    }, () => {
      done()
      if (current()) setSaid(p.texts.failed)
    })
  }
  return (
    <article
      data-testid="presentation"
      data-kind={p.content.kind}
      data-lifetime={p.lifetime}
      className="w-full shrink-0 rounded-lg border border-line bg-surface px-4 py-3 text-ink shadow-panel animate-[pva-rise_200ms_var(--ease-out)]"
    >
      <Content p={p} pending={pending} onTick={(item, doneNow) => press(`tick:${item}`, { action: "tick", item, done: doneNow })} />
      {said !== undefined ? <p className="mt-1 text-[13px] text-ink-muted [overflow-wrap:anywhere]" role="status">{said}</p> : null}
      {p.buttons.length > 0
        ? (
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            {p.buttons.map((b) => (
              <button
                key={b.id}
                type="button"
                data-action={b.id}
                disabled={!p.interactive || pending.has(b.id)}
                onClick={() => press(b.id, { action: b.id })}
                className="inline-flex min-h-11 max-w-full items-center whitespace-normal rounded-md border border-line bg-surface px-4 py-1 text-left text-[14px] text-ink [overflow-wrap:anywhere] hover:bg-surface-2 disabled:opacity-50"
              >
                {b.label}
              </button>
            ))}
          </div>
        )
        : null}
    </article>
  )
}

function Content(props: { readonly p: HeldPresentation; readonly pending: ReadonlySet<string>; readonly onTick: (item: string, done: boolean) => void }) {
  const c: PresentContent = props.p.content
  switch (c.kind) {
    case "card":
      return (
        <div>
          <h2 className="text-[15px] font-medium [overflow-wrap:anywhere]">{c.title}</h2>
          {c.text !== undefined ? <p className="mt-0.5 whitespace-pre-line text-[14px] text-ink-muted [overflow-wrap:anywhere]">{c.text}</p> : null}
          {c.facts.length > 0
            ? (
              <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[14px]">
                {c.facts.map((f, i) => (
                  <div key={i} className="contents">
                    <dt className="text-ink-faint [overflow-wrap:anywhere]">{f.label}</dt>
                    <dd className="[overflow-wrap:anywhere]">{f.value}</dd>
                  </div>
                ))}
              </dl>
            )
            : null}
        </div>
      )
    case "list":
      return (
        <div>
          <h2 className="text-[15px] font-medium [overflow-wrap:anywhere]">{c.title}</h2>
          {c.style === "bullets"
            ? <ul className="mt-1 list-disc pl-5 text-[14px]">{c.items.map((i) => <li key={i.id} className="[overflow-wrap:anywhere]">{i.text}</li>)}</ul>
            : (
              <ul className="mt-1 flex flex-col text-[14px]">
                {c.items.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={i.done}
                      data-item={i.id}
                      disabled={!props.p.interactive || props.pending.has(`tick:${i.id}`)}
                      onClick={() => props.onTick(i.id, !i.done)}
                      className="flex min-h-11 w-full items-center gap-3 rounded-md px-1 text-left hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span aria-hidden="true" className={cx("flex size-5 shrink-0 items-center justify-center rounded border", i.done ? "border-ink bg-ink text-surface" : "border-line")}>
                        {i.done ? <svg viewBox="0 0 20 20" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2}><path d="M4.5 10.5l3.5 3.5 7.5-8" /></svg> : null}
                      </span>
                      <span className={cx("min-w-0 [overflow-wrap:anywhere]", i.done && "text-ink-faint line-through")}>{i.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )
    case "timer":
      return <TimerView label={c.label} endsAt={c.endsAt} serverNow={props.p.serverNow} receivedMono={props.p.receivedMono} done={props.p.texts.timerDone} />
    case "image":
      return (
        <figure className="flex flex-col gap-1">
          {c.image.state === "ready"
            ? <ReadyImage key={c.image.token} token={c.image.token} alt={c.alt} missing={props.p.texts.imageMissing} />
            : <p className="text-[14px] text-ink-faint" data-testid="image-state">{c.image.state === "loading" ? props.p.texts.loading : props.p.texts.imageMissing}</p>}
          <figcaption className="text-[13px] text-ink-muted">
            {c.caption !== undefined ? <span className="block [overflow-wrap:anywhere]">{c.caption}</span> : null}
            <span className="block text-[12px] text-ink-faint [overflow-wrap:anywhere]">{props.p.texts.credit} {c.credit}</span>
          </figcaption>
        </figure>
      )
    case "weather":
      return (
        <div>
          <h2 className="text-[15px] font-medium [overflow-wrap:anywhere]">{c.place}</h2>
          <div className="mt-1 flex items-center gap-3">
            <WeatherSymbol icon={c.now.icon} size={36} />
            <span className="min-w-0 text-[28px] leading-none tabular-nums [overflow-wrap:anywhere]">{c.now.temperature}</span>
            <span className="min-w-0 text-[14px] text-ink-muted [overflow-wrap:anywhere]">{c.now.condition}</span>
          </div>
          {c.days.length > 0
            ? (
              <ul className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(48px,1fr))] gap-2 text-center text-[13px]">
                {c.days.map((d, i) => (
                  <li key={i} className="flex min-w-0 flex-col items-center gap-0.5 [overflow-wrap:anywhere]">
                    <span className="text-ink-faint [overflow-wrap:anywhere]">{d.label}</span>
                    <WeatherSymbol icon={d.icon} size={22} />
                    <span className="tabular-nums"><span className="sr-only">{props.p.texts.high} </span>{d.high}</span>
                    <span className="tabular-nums text-ink-faint"><span className="sr-only">{props.p.texts.low} </span>{d.low}</span>
                  </li>
                ))}
              </ul>
            )
            : null}
        </div>
      )
  }
}

/** This page's own image address; one the browser could not load shows the server's sentence for a missing image. */
function ReadyImage(props: { readonly token: string; readonly alt: string; readonly missing: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p className="text-[14px] text-ink-faint" data-testid="image-state">{props.missing}</p>
  return <img src={`/media/${props.token}`} alt={props.alt} decoding="async" onError={() => setFailed(true)} className="max-h-[32dvh] w-full rounded-md object-contain" />
}

/** A countdown to the server's instant, on this page's clock corrected by the offset taken when it arrived. */
function TimerView(props: { readonly label: string; readonly endsAt: number; readonly serverNow: number; readonly receivedMono: number; readonly done: string }) {
  const [mono, setMono] = useState(() => pageClock.mono())
  const left = remainingMs(props.endsAt, props.serverNow, props.receivedMono, mono)
  // Ticks on the monotonic clock until it is over by that clock (a jump of the wall clock neither ends nor freezes it).
  useEffect(() => {
    if (left <= 0) return
    const t = setInterval(() => setMono(pageClock.mono()), 250)
    return () => clearInterval(t)
  }, [left <= 0, props.receivedMono])
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="min-w-0 text-[15px] font-medium [overflow-wrap:anywhere]">{props.label}</h2>
      <span role="timer" data-testid="timer-left" className="shrink-0 text-[28px] leading-none tabular-nums">{left > 0 ? formatRemaining(left) : props.done}</span>
    </div>
  )
}

/** The host's own symbols for the closed set of weather icons (drawn by the page; nothing from the server is markup). */
function WeatherSymbol({ icon, size }: { readonly icon: WeatherIcon; readonly size: number }) {
  const sun = <circle cx="10" cy="10" r="3.5" />
  const cloud = <path d="M6 15h8a3 3 0 0 0 0-6 4.5 4.5 0 0 0-8.6 1.2A2.5 2.5 0 0 0 6 15z" />
  const shapes: Record<WeatherIcon, React.ReactNode> = {
    sun: <>{sun}<path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></>,
    partly: <><circle cx="7" cy="7" r="2.5" /><path d="M7 2.5v1M2.5 7h1M3.8 3.8l.7.7" />{cloud}</>,
    cloud,
    rain: <>{cloud}<path d="M7 17l-.5 1.5M10 17l-.5 1.5M13 17l-.5 1.5" /></>,
    snow: <>{cloud}<path d="M7 17.5h.01M10 18h.01M13 17.5h.01" /></>,
    storm: <>{cloud}<path d="M10.5 15.5 9 18h2l-1.5 2" /></>,
    fog: <path d="M4 8h12M3 11h14M5 14h10" />,
    wind: <path d="M3 8h9a2 2 0 1 0-2-2M3 12h12a2 2 0 1 1-2 2" />,
    night: <path d="M13.5 13.5A6 6 0 0 1 8 4a6 6 0 1 0 8 7.5 6 6 0 0 1-2.5 2z" />
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-muted">
      {shapes[icon]}
    </svg>
  )
}
