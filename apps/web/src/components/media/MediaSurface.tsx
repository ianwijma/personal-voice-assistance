"use client"
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import type { MediaController } from "@/lib/media/controller.ts"
import type { MediaView } from "@/lib/media/types.ts"
import { useClient, useClientState } from "../context.tsx"
import { cx } from "../ui/controls.tsx"
import { Icon } from "../ui/Icon.tsx"
import { clock, type MediaTexts, mediaTexts } from "./texts.ts"

/**
 * The player surface on the voice stage (docs/modules/media.md §5), separate from presentations: the music panel
 * (Spotify) and the theatre (YouTube). Both are driven by the page's `MediaController`; a touch on our buttons calls it
 * directly, with no round trip, and the result is reported to the server like any change.
 *
 * - **Music panel**: cover, title, artist, a visible Spotify mark that links back (Spotify's policy), previous / play or
 *   pause / next, a position slider, a volume slider and close. On a phone it sits above the controls; from 1024 px it
 *   docks at the right of the stage, beside the character, which stays where it is.
 * - **Theatre**: YouTube's frame at 16:9, as large as the viewport allows, with a strip of our own (title, status,
 *   close) *above* it, never over it (YouTube Developer Policies III.I.4/6). The character becomes a corner badge at
 *   the left of that strip (globals.css `data-theatre-badge`: the box gets smaller and moves, as it already does for
 *   presentations; the character contract is unchanged) and is the normal box again while the assistant talks, when
 *   the video is paused anyway; the frame then starts below the box.
 *
 * Escape closes it like a presentation (not while a reply plays, not in a field or dialog, and a presentation goes
 * first). Every text of a title or an artist is put on the page as text, never as markup; an address becomes an
 * image or a link only when it is the provider's own (`i.scdn.co`, `open.spotify.com`).
 */
export function MediaSurface() {
  const media = useClient().media
  if (media === undefined) return null
  return <Surface media={media} />
}

const SPOTIFY_ART = /^https:\/\/i\.scdn\.co\//
const SPOTIFY_LINK = /^https:\/\/open\.spotify\.com\//

/** The page's language is read at render (a household switching language reloads the page). */
const useTexts = (): MediaTexts => useRef(mediaTexts()).current

function Surface({ media }: { readonly media: MediaController }) {
  const view = useSyncExternalStore(media.subscribe, media.getView, media.getView)
  const chatOpen = useClientState((s) => s.ui.chatOpen)
  const t = useTexts()
  const source = view.current?.source
  const shown = source === "spotify" || source === "youtube"
  // Escape closes (where a keyboard exists): presentations, panels, menus and a playing reply first.
  const client = useClient()
  const latest = useRef({ shown, media })
  latest.current = { shown, media }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (!latest.current.shown) return
      const target = e.target instanceof Element ? e.target : null
      if (target !== null && target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role=dialog], [role=menu], [role=listbox]") !== null) return
      const s = client.store.get()
      if (s.ui.sheetOpen || s.ui.shortcutsOpen || s.presentations.length > 0 || s.session.serverState === "thinking" || s.session.serverState === "speaking" || s.audio.playing !== undefined) return
      e.preventDefault()
      latest.current.media.touch({ type: "close" })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [client])
  // The page's CSS reads these on the root (globals.css `data-music`, `data-theatre`, `data-theatre-badge`).
  const theatre = source === "youtube"
  const badge = theatre && !chatOpen && !view.talking
  useLayoutEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const set = (name: string, on: boolean) => (on ? root.setAttribute(name, "") : root.removeAttribute(name))
    set("data-music", source === "spotify")
    set("data-theatre", theatre)
    set("data-theatre-badge", badge)
    return () => {
      root.removeAttribute("data-music")
      root.removeAttribute("data-theatre")
      root.removeAttribute("data-theatre-badge")
      root.style.removeProperty("--pva-theatre-top")
    }
  }, [source, theatre, badge])
  if (view.current === undefined || !shown) return null
  return source === "spotify" ? <MusicPanel media={media} view={view} texts={t} hidden={chatOpen} /> : <Theatre media={media} view={view} texts={t} />
}

// -- Shared ---------------------------------------------------------------------------------------------------------

type Touch = Parameters<MediaController["touch"]>[0]

const button = "inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"

/** The position now: the reported one plus the time since, while it plays. Ticks twice a second only then. */
const usePosition = (view: MediaView): number | undefined => {
  const c = view.current
  const [now, setNow] = useState(() => Date.now())
  const playing = c?.status === "playing"
  useEffect(() => {
    if (!playing) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [playing, c?.sampledAt])
  if (c?.positionMs === undefined) return undefined
  const p = playing ? c.positionMs + Math.max(0, now - c.sampledAt) : c.positionMs
  return c.durationMs !== undefined && c.durationMs > 0 ? Math.min(p, c.durationMs) : p
}

const errorText = (t: MediaTexts, code: string | undefined) => (code !== undefined ? t.errors[code] : undefined) ?? t.fallbackError

/** A short line under the metadata: loading, blocked autoplay, or the reason it failed. */
function StatusLine({ view, texts }: { readonly view: MediaView; readonly texts: MediaTexts }) {
  const c = view.current
  if (c === undefined) return null
  const text = c.status === "error" ? errorText(texts, c.errorCode) : c.status === "blocked" ? texts.blocked : c.status === "loading" ? texts.loading : undefined
  return text === undefined ? null : <p role="status" data-testid="media-status" className="text-[14px] text-ink-muted [overflow-wrap:anywhere]">{text}</p>
}

// -- Music panel ----------------------------------------------------------------------------------------------------

/** Spotify's mark, drawn small and recognisable; the panel always shows it (Spotify's design rules: art and metadata link back). */
function SpotifyMark({ size = 20 }: { readonly size?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} className="shrink-0">
      <circle cx="12" cy="12" r="12" fill="#1DB954" />
      <path d="M5.6 8.7c4.2-1.2 8.9-.9 12.8 1.4M6.2 12.2c3.6-1 7.5-.7 10.8 1.2M6.9 15.4c3-.8 6-.5 8.7 1" fill="none" stroke="#000" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export function MusicPanel({ media, view, texts, hidden = false }: { readonly media: MediaController; readonly view: MediaView; readonly texts: MediaTexts; readonly hidden?: boolean }) {
  const c = view.current!
  const position = usePosition(view)
  const [scrub, setScrub] = useState<number | undefined>(undefined)
  const touch = (command: Touch) => media.touch(command)
  const playing = c.status === "playing"
  const art = c.artUrl !== undefined && SPOTIFY_ART.test(c.artUrl) ? c.artUrl : undefined
  const link = c.link !== undefined && SPOTIFY_LINK.test(c.link) ? c.link : undefined
  const duration = c.durationMs
  const shownPosition = scrub ?? position ?? 0
  const commit = () => {
    if (scrub === undefined) return
    touch({ type: "seek", toMs: Math.round(scrub) })
    setScrub(undefined)
  }
  const metaLink = (children: React.ReactNode) =>
    link !== undefined
      ? <a href={link} target="_blank" rel="noopener noreferrer" className="rounded outline-offset-2 hover:underline focus-visible:outline-2">{children}</a>
      : <>{children}</>
  return (
    <aside
      data-testid="music-panel"
      data-status={c.status}
      aria-label={texts.nowPlaying}
      hidden={hidden}
      inert={hidden}
      className={cx(
        "fixed z-[5] flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 text-ink shadow-panel animate-[pva-rise_200ms_var(--ease-out)]",
        // A phone: above the controls, as wide as the screen allows. From 1024 px: at the right of the stage, beside the character.
        "inset-x-3 bottom-[calc(96px_+_env(safe-area-inset-bottom))] mx-auto max-w-[420px]",
        "lg:inset-x-auto lg:bottom-auto lg:right-6 lg:top-[calc(var(--pva-notifications-space,0px)_+_56px_+_16px)] lg:mx-0 lg:w-[340px]",
        hidden && "hidden"
      )}
    >
      <div className="flex items-start gap-3">
        {art !== undefined
          ? <img src={art} alt={c.album ?? c.title ?? ""} referrerPolicy="no-referrer" decoding="async" className="size-16 shrink-0 rounded-md bg-surface-2 object-cover sm:size-20" />
          : <div aria-hidden="true" data-testid="music-art-empty" className="flex size-16 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-faint sm:size-20"><SpotifyMark size={28} /></div>}
        <div className="min-w-0 flex-1">
          <p data-testid="music-title" className="truncate text-[17px] font-medium leading-snug" title={c.title}>{c.title !== undefined ? metaLink(c.title) : texts.loading}</p>
          {c.artist !== undefined ? <p data-testid="music-artist" className="truncate text-[15px] text-ink-muted" title={c.artist}>{c.artist}</p> : null}
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-faint" data-testid="spotify-attribution">
            <SpotifyMark size={16} />
            {link !== undefined
              ? <a href={link} target="_blank" rel="noopener noreferrer" className="rounded hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">{texts.openInSpotify}</a>
              : <span>{texts.spotify}</span>}
          </p>
        </div>
        <button type="button" data-testid="media-close" aria-label={texts.close} title={texts.close} onClick={() => touch({ type: "close" })} className={cx(button, "-mr-1 -mt-1 border-transparent bg-transparent text-ink-muted hover:text-ink")}>
          <Icon name="close" size={20} />
        </button>
      </div>
      <StatusLine view={view} texts={texts} />
      <div className="flex items-center gap-2 text-[13px] tabular-nums text-ink-muted">
        <span data-testid="music-position" className="w-10 shrink-0 text-right">{clock(shownPosition)}</span>
        <input
          type="range"
          aria-label={texts.position}
          data-testid="music-seek"
          min={0}
          max={Math.max(1, duration ?? 1)}
          step={1000}
          disabled={duration === undefined || duration <= 0}
          value={Math.min(shownPosition, Math.max(1, duration ?? 1))}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="h-11 min-w-0 flex-1 accent-[var(--color-voice)]"
        />
        <span data-testid="music-duration" className="w-10 shrink-0">{duration !== undefined ? clock(duration) : "–:––"}</span>
      </div>
      <div className="flex items-center justify-center gap-3">
        <button type="button" data-testid="media-previous" aria-label={texts.previous} title={texts.previous} disabled={c.canPrevious !== true} onClick={() => touch({ type: "previous" })} className={button}>
          <Icon name="skipPrevious" size={22} />
        </button>
        <button
          type="button"
          data-testid="media-playpause"
          aria-label={playing ? texts.pause : texts.play}
          title={playing ? texts.pause : texts.play}
          onClick={() => touch({ type: playing ? "pause" : "play" })}
          className={cx(button, "size-14 border-ink bg-ink text-bg hover:bg-ink/90")}
        >
          <Icon name={playing ? "pause" : "play"} size={26} />
        </button>
        <button type="button" data-testid="media-next" aria-label={texts.next} title={texts.next} disabled={c.canNext !== true} onClick={() => touch({ type: "next" })} className={button}>
          <Icon name="skipNext" size={22} />
        </button>
      </div>
      <label className="flex items-center gap-2 text-ink-muted">
        <Icon name="speaker" size={18} />
        <span className="sr-only">{texts.volume}</span>
        <input
          type="range"
          aria-label={texts.volume}
          data-testid="music-volume"
          min={0}
          max={1}
          step={0.05}
          value={view.volume ?? 0.8}
          onChange={(e) => touch({ type: "volume", level: Number(e.target.value) })}
          className="h-11 min-w-0 flex-1 accent-[var(--color-voice)]"
        />
      </label>
    </aside>
  )
}

// -- Theatre --------------------------------------------------------------------------------------------------------

/** Measure where the frame may start: below the strip when the character is a badge, below the character's box and label while it talks. */
const frameTop = (badge: boolean): string => {
  const fallback = "calc(var(--pva-notifications-space, 0px) + 56px + 8px)"
  if (badge || typeof document === "undefined") return fallback
  const anchor = document.querySelector('[data-testid="state-label-box"]') ?? document.querySelector(".stage-vis")
  const bottom = anchor?.getBoundingClientRect().bottom ?? 0
  return bottom > 0 ? `${Math.ceil(bottom) + 8}px` : fallback
}

export function Theatre({ media, view, texts }: { readonly media: MediaController; readonly view: MediaView; readonly texts: MediaTexts }) {
  const c = view.current!
  const frame = useRef<HTMLDivElement>(null)
  const chatOpen = useClientState((s) => s.ui.chatOpen)
  const badge = !chatOpen && !view.talking
  // The frame's element is ours and stays put while the video is open (moving an iframe reloads it).
  useEffect(() => {
    const el = frame.current
    const player = media.surface("youtube")
    if (el === null || player === undefined) return
    player.mount(el)
    return () => player.unmount()
  }, [media])
  // Where the frame may start follows the character: a badge in the strip, or its normal box while it talks.
  const [, force] = useState(0)
  useLayoutEffect(() => {
    if (typeof document === "undefined") return
    document.documentElement.style.setProperty("--pva-theatre-top", frameTop(badge))
    const onResize = () => {
      document.documentElement.style.setProperty("--pva-theatre-top", frameTop(badge))
      force((n) => n + 1)
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [badge, view.talking])
  const failed = c.status === "error"
  const title = c.title ?? texts.video
  return (
    <div
      data-testid="theatre"
      data-status={c.status}
      data-badge={badge || undefined}
      className={cx(
        "pointer-events-none fixed inset-x-0 z-[6] flex flex-col items-center transition-transform duration-[320ms] ease-out",
        "top-[var(--pva-theatre-top,calc(var(--pva-notifications-space,0px)_+_56px_+_8px))] bottom-[calc(96px_+_env(safe-area-inset-bottom))]",
        chatOpen && "lg:max-[1439px]:-translate-x-[200px]"
      )}
    >
      <div className="pointer-events-auto flex w-[var(--pva-theatre-w)] max-w-full flex-col">
        {/* Our controls: a strip of its own above the frame. Nothing of ours is ever drawn over the frame. */}
        <div data-testid="theatre-strip" className={cx("flex h-14 shrink-0 items-center gap-2 rounded-t-xl border border-b-0 border-line bg-surface px-2 text-ink", badge && "pl-[84px]")}>
          <div className="min-w-0 flex-1">
            <p data-testid="theatre-title" className="truncate text-[15px] font-medium leading-tight" title={title}>{title}</p>
            {c.status === "error" || c.status === "blocked" || c.status === "loading"
              ? <p role="status" data-testid="media-status" className="truncate text-[13px] text-ink-muted">{c.status === "error" ? errorText(texts, c.errorCode) : c.status === "blocked" ? texts.blocked : texts.loading}</p>
              : c.artist !== undefined ? <p className="truncate text-[13px] text-ink-muted" title={c.artist}>{c.artist}</p> : null}
          </div>
          <button type="button" data-testid="media-close" aria-label={texts.closeVideo} title={texts.closeVideo} onClick={() => media.touch({ type: "close" })} className={cx(button, "border-transparent bg-transparent text-ink-muted hover:text-ink")}>
            <Icon name="close" size={20} />
          </button>
        </div>
        {/* YouTube's frame, 16:9, with its own controls. The player draws into this element and nothing else is in it. */}
        <div ref={frame} data-testid="theatre-frame" aria-label={title} className={cx("aspect-video w-full overflow-hidden bg-black", failed && "opacity-60")} />
      </div>
    </div>
  )
}
