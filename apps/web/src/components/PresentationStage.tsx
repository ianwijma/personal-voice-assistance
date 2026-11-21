"use client"
import type { PresentContent, WeatherIcon } from "@pva/protocol"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { formatRemaining, remainingMs } from "@/lib/countdown.ts"
import { type HeldPresentation, pageClock } from "@/lib/state.ts"
import { useClient, useClientState } from "./context.tsx"
import { cx } from "./ui/controls.tsx"
import { Icon } from "./ui/Icon.tsx"

/**
 * P10: the presentation stage (docs/PRESENTING.md "The voice page"; docs/CHARACTERS.md §2.7). While it shows something
 * it takes most of the screen: from just under the header and the character's shrunken box down to just above the
 * controls, as wide as the screen on a phone and centred up to 960 px on a larger one (text kinds keep a readable
 * measure of at most 680 px). The character yields while it is up: the stage sets `data-presenting` on the root and the
 * page's CSS shrinks the box to a strip (`--pva-vis-mini`) and steps the captions aside; when the last presentation goes
 * (or a menu, a panel or the chat covers the stage) everything is as before. The box, its canvas and the focus it is
 * given follow the box as they always did.
 *
 * It holds presentations, a transient one first, then the pinned ones, and scrolls within itself when they do not fit.
 * Open page menus and dialogs hide them; notifications have their own fixed region above those surfaces. Every word the
 * host shows comes from the server in the household's language (`texts`); every text of a presentation passed the
 * server's page boundary and is put on the page as text, never as markup. An image is only ever `/media/<token>`, the
 * server's copy.
 *
 * Closing: a presentation the server marked `closable` (this device can press things) has a close button, and Escape
 * closes the newest one (unless a reply is playing: Escape stops that first). The page hides it at once and sends
 * `present.close`; the server dismisses it for every page that holds it. Refused, it comes back with the server's
 * sentence (or `texts.failed` when there was no answer).
 */
export function PresentationStage({ obscured = false }: { readonly obscured?: boolean }) {
  const client = useClient()
  const items = useClientState((s) => s.presentations)
  const chatOpen = useClientState((s) => s.ui.chatOpen)
  /** Closed here and not yet withdrawn by the server: id → the revision that was closed. */
  const [closing, setClosing] = useState<ReadonlyMap<string, string>>(new Map())
  /** A refused close: the server's sentence, shown on the presentation while that revision is held. */
  const [refused, setRefused] = useState<ReadonlyMap<string, { readonly revision: string; readonly say: string }>>(new Map())
  const visible = items.filter((p) => !closing.has(p.id))
  const presenting = visible.length > 0 && !obscured
  // Forget what the server has withdrawn (a closed id that is gone is done; one shown again later is a new showing).
  useEffect(() => {
    const held = new Set(items.map((p) => p.id))
    setClosing((m) => ([...m.keys()].every((id) => held.has(id)) ? m : new Map([...m].filter(([id]) => held.has(id)))))
    setRefused((m) => ([...m].every(([id, r]) => items.some((p) => p.id === id && p.revision === r.revision)) ? m : new Map([...m].filter(([id, r]) => items.some((p) => p.id === id && p.revision === r.revision)))))
  }, [items])
  // The character yields while something is shown (globals.css `data-presenting`).
  useLayoutEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    if (!presenting) {
      root.removeAttribute("data-presenting")
      return
    }
    root.setAttribute("data-presenting", "")
    return () => root.removeAttribute("data-presenting")
  }, [presenting])
  const close = (p: HeldPresentation) => {
    if (p.closable !== true || closing.has(p.id)) return
    setClosing((m) => new Map(m).set(p.id, p.revision))
    setRefused((m) => {
      if (!m.has(p.id)) return m
      const next = new Map(m)
      next.delete(p.id)
      return next
    })
    const restore = (say: string | undefined) => {
      // Shown again only while the server still has it here; its answer goes with the revision it was given for.
      const now = client.store.get().presentations.find((x) => x.id === p.id)
      setClosing((m) => {
        if (m.get(p.id) !== p.revision) return m
        const next = new Map(m)
        next.delete(p.id)
        return next
      })
      if (now !== undefined && say !== undefined) setRefused((m) => new Map(m).set(p.id, { revision: now.revision, say }))
    }
    // continuation(identity): restores only this presentation, only if the server refused and still holds it.
    void client.request({ type: "present.close", id: p.id, revision: p.revision }).then((r) => {
      if (!r.ok) restore(r.say ?? p.texts.failed)
    }, () => restore(p.texts.failed))
  }
  const ordered = [...visible.filter((p) => p.lifetime === "transient"), ...visible.filter((p) => p.lifetime === "pinned").sort((a, b) => a.shownAt - b.shownAt)]
  // Escape closes the newest closable presentation (where a keyboard exists). Panels, menus and a playing reply first.
  const latest = useRef({ ordered, presenting, close })
  latest.current = { ordered, presenting, close }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const { ordered: shown, presenting: up, close: closeOne } = latest.current
      if (!up) return
      const target = e.target instanceof Element ? e.target : null
      if (target !== null && target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role=dialog], [role=menu], [role=listbox]") !== null) return
      const s = client.store.get()
      if (s.ui.sheetOpen || s.ui.shortcutsOpen || s.session.serverState === "thinking" || s.session.serverState === "speaking" || s.audio.playing !== undefined) return
      const newest = shown.filter((p) => p.closable === true).sort((a, b) => b.shownAt - a.shownAt || (a.id < b.id ? 1 : -1))[0]
      if (newest === undefined) return
      e.preventDefault()
      closeOne(newest)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [client])
  if (ordered.length === 0) return null
  return (
    <div
      data-testid="present-stage"
      className={cx(
        "pointer-events-none fixed inset-x-0 z-[5] flex items-center justify-center pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] transition-transform duration-[320ms] ease-out sm:pl-[max(24px,env(safe-area-inset-left))] sm:pr-[max(24px,env(safe-area-inset-right))]",
        // From under the header and the character's strip to just above the controls (globals.css `--pva-present-gap`).
        "top-[calc(var(--pva-notifications-space,0px)_+_56px_+_var(--pva-present-gap,76px))] bottom-[calc(96px_+_env(safe-area-inset-bottom))]",
        // What an image may take of the height: the area less its card's padding, caption and credit (and buttons).
        "[--pva-present-room:calc(100dvh_-_var(--pva-notifications-space,0px)_-_56px_-_var(--pva-present-gap,76px)_-_96px_-_env(safe-area-inset-bottom))]",
        chatOpen && "lg:max-[1439px]:-translate-x-[200px]"
      )}
    >
      <div className="pointer-events-auto flex max-h-full w-full max-w-[960px] flex-col overflow-y-auto overscroll-contain scrollbar-quiet">
        <section
          aria-label={ordered[0]!.texts.region}
          data-testid="presentations"
          hidden={obscured}
          inert={obscured}
          className={cx("w-full flex-col items-center gap-3", obscured ? "hidden" : "flex")}
        >
          {ordered.map((p) => (
            <PresentationCard
              key={`${p.id}:${p.revision}`}
              p={p}
              notice={refused.get(p.id)?.revision === p.revision ? refused.get(p.id)!.say : undefined}
              onClose={() => close(p)}
            />
          ))}
        </section>
      </div>
    </div>
  )
}

/** One presentation: its kind's renderer, its buttons, its close button, and the answer to the last press while it is still held. */
function PresentationCard({ p, notice, onClose }: { readonly p: HeldPresentation; readonly notice: string | undefined; readonly onClose: () => void }) {
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
  /** A tick or a button: one request each; the answer is shown only while this presentation is still held. */
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
  const closable = p.closable === true && p.texts.close !== undefined
  const image = p.content.kind === "image"
  const shown = notice ?? said
  return (
    <article
      data-testid="presentation"
      data-kind={p.content.kind}
      data-lifetime={p.lifetime}
      className={cx(
        "relative w-full shrink-0 rounded-xl border border-line bg-surface text-ink shadow-panel animate-[pva-rise_200ms_var(--ease-out)]",
        image ? "max-w-[960px] p-3 sm:p-4" : "max-w-[680px] px-5 py-4 sm:px-6 sm:py-5",
        // The close button's corner stays clear of a title.
        closable && !image && "pr-14 sm:pr-16"
      )}
    >
      <Content p={p} pending={pending} onTick={(item, doneNow) => press(`tick:${item}`, { action: "tick", item, done: doneNow })} />
      {shown !== undefined ? <p className="mt-2 text-[15px] text-ink-muted [overflow-wrap:anywhere]" role="status">{shown}</p> : null}
      {p.buttons.length > 0
        ? (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {p.buttons.map((b) => (
              <button
                key={b.id}
                type="button"
                data-action={b.id}
                disabled={!p.interactive || pending.has(b.id)}
                onClick={() => press(b.id, { action: b.id })}
                className="inline-flex min-h-11 max-w-full items-center whitespace-normal rounded-md border border-line bg-surface px-4 py-1 text-left text-[15px] text-ink [overflow-wrap:anywhere] hover:bg-surface-2 disabled:opacity-50"
              >
                {b.label}
              </button>
            ))}
          </div>
        )
        : null}
      {closable
        ? (
          <button
            type="button"
            data-testid="presentation-close"
            aria-label={p.texts.close}
            title={p.texts.close}
            onClick={onClose}
            className="absolute right-1.5 top-1.5 inline-flex size-11 items-center justify-center rounded-full border border-line bg-surface/90 text-ink-muted shadow-sm transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 sm:right-2 sm:top-2"
          >
            <Icon name="close" size={20} />
          </button>
        )
        : null}
    </article>
  )
}

/** A presentation's title: larger than the page's text, for reading from across a room. */
const TITLE = "min-w-0 text-[20px] font-medium leading-snug [overflow-wrap:anywhere] sm:text-[24px]"

function Content(props: { readonly p: HeldPresentation; readonly pending: ReadonlySet<string>; readonly onTick: (item: string, done: boolean) => void }) {
  const c: PresentContent = props.p.content
  switch (c.kind) {
    case "card":
      return (
        <div>
          <h2 className={TITLE}>{c.title}</h2>
          {c.text !== undefined ? <p className="mt-1 whitespace-pre-line text-[17px] leading-relaxed text-ink-muted [overflow-wrap:anywhere] sm:text-[19px]">{c.text}</p> : null}
          {c.facts.length > 0
            ? (
              <dl className="mt-3 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[17px] sm:text-[19px]">
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
          <h2 className={TITLE}>{c.title}</h2>
          {c.style === "bullets"
            ? <ul className="mt-2 flex list-disc flex-col gap-1 pl-6 text-[17px] sm:text-[19px]">{c.items.map((i) => <li key={i.id} className="[overflow-wrap:anywhere]">{i.text}</li>)}</ul>
            : (
              <ul className="mt-1 flex flex-col text-[17px] sm:text-[19px]">
                {c.items.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={i.done}
                      data-item={i.id}
                      disabled={!props.p.interactive || props.pending.has(`tick:${i.id}`)}
                      onClick={() => props.onTick(i.id, !i.done)}
                      className="flex min-h-12 w-full items-center gap-3 rounded-md px-1 text-left hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span aria-hidden="true" className={cx("flex size-6 shrink-0 items-center justify-center rounded border", i.done ? "border-ink bg-ink text-surface" : "border-line")}>
                        {i.done ? <svg viewBox="0 0 20 20" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2}><path d="M4.5 10.5l3.5 3.5 7.5-8" /></svg> : null}
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
        <figure className="flex flex-col gap-2">
          {c.image.state === "ready"
            ? <ReadyImage key={c.image.token} token={c.image.token} alt={c.alt} missing={props.p.texts.imageMissing} buttons={props.p.buttons.length > 0} />
            : <p className="flex min-h-40 items-center justify-center px-12 text-center text-[16px] text-ink-faint" data-testid="image-state">{c.image.state === "loading" ? props.p.texts.loading : props.p.texts.imageMissing}</p>}
          <figcaption className="px-1 text-[15px] text-ink-muted sm:text-[17px]">
            {c.caption !== undefined ? <span className="block [overflow-wrap:anywhere]">{c.caption}</span> : null}
            <span className="block text-[13px] text-ink-faint [overflow-wrap:anywhere]">{props.p.texts.credit} {c.credit}</span>
          </figcaption>
        </figure>
      )
    case "weather":
      return (
        <div>
          <h2 className={TITLE}>{c.place}</h2>
          <div className="mt-2 flex items-center gap-4">
            <WeatherSymbol icon={c.now.icon} size={56} />
            <span className="min-w-0 text-[44px] leading-none tabular-nums [overflow-wrap:anywhere] sm:text-[56px]">{c.now.temperature}</span>
            <span className="min-w-0 text-[17px] text-ink-muted [overflow-wrap:anywhere] sm:text-[19px]">{c.now.condition}</span>
          </div>
          {c.days.length > 0
            ? (
              <ul className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(56px,1fr))] gap-3 text-center text-[15px] sm:text-[17px]">
                {c.days.map((d, i) => (
                  <li key={i} className="flex min-w-0 flex-col items-center gap-0.5 [overflow-wrap:anywhere]">
                    <span className="text-ink-faint [overflow-wrap:anywhere]">{d.label}</span>
                    <WeatherSymbol icon={d.icon} size={28} />
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
function ReadyImage(props: { readonly token: string; readonly alt: string; readonly missing: string; readonly buttons: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p className="flex min-h-40 items-center justify-center px-12 text-center text-[16px] text-ink-faint" data-testid="image-state">{props.missing}</p>
  // As large as the presentation area allows, its caption and credit (and buttons) still in view below it: scaled to fit.
  return (
    <img
      src={`/media/${props.token}`}
      alt={props.alt}
      decoding="async"
      onError={() => setFailed(true)}
      className={cx(
        "h-auto w-full rounded-lg object-contain",
        props.buttons ? "max-h-[max(120px,calc(var(--pva-present-room,60dvh)_-_164px))]" : "max-h-[max(120px,calc(var(--pva-present-room,60dvh)_-_112px))]"
      )}
    />
  )
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
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <h2 className={TITLE}>{props.label}</h2>
      <span role="timer" data-testid="timer-left" className="shrink-0 text-[48px] leading-none tabular-nums sm:text-[64px]">{left > 0 ? formatRemaining(left) : props.done}</span>
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
