"use client"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { WAKE_TEST_MAX_MS } from "@pva/protocol"
import { normalisePhrase, phraseFromHeard } from "@/lib/profileForm.ts"
import { displayPhrase, type HeardLine, heardOutcome } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../context.tsx"
import { inputClass } from "../fields/types.ts"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"

const listHas = (list: ReadonlyArray<string>, phrase: string): boolean => list.includes(normalisePhrase(phrase))

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** The words for a line's outcome, as shown and as announced (`who`: the assistant a matched line woke). */
const outcomeText = (l: HeardLine, who?: string): string => {
  switch (heardOutcome(l)) {
    case "matched": {
      return `Matched ${displayPhrase(l.matched!)}${who !== undefined ? ` → wakes ${who}` : ""}`
    }
    case "accepted":
      return "Accepted without a phrase"
    case "ignored":
      return "Ignored"
    case "no-match":
      return "No phrase matched"
  }
}

/**
 * The phrase tester (docs/FRONTENDS-AND-ACTIVATION.md §5): while on, what the recogniser hears from one device's voice
 * session (protocol 6: picked in "Listen to" when several devices have one; by default the most recently active
 * device that is talking), line by line, marked matched (with the phrase), accepted without a phrase (always
 * listening, or inside an armed or follow-up window) or ignored; `Add "…"` turns a mishearing into a
 * phrase of its own. Lines are judged by the server with that device's saved, effective settings, so the tester says
 * which device it tests, whether that device has its own wake settings, and that unsaved edits on this page are not
 * tested. Start, stop, expiry and each new line are announced through one polite region (the countdown is not).
 * It switches off after 5 minutes and when the page is left.
 */
export function PhraseTester({ onAdd, phrases: draftPhrases = [], savedPhrases = [], deviceId, deviceName, wakes }: {
  /** Turn a mishearing into a phrase of the form; without it the lines have no Add button. */
  readonly onAdd?: (phrase: string) => string | undefined
  /** Test this device only (the device page), not "the device talking most recently". */
  readonly deviceId?: string
  readonly deviceName?: string
  /** The assistant a phrase wakes on the tested device (`deviceId`: the device being tested; named after a matched line). */
  readonly wakes?: (phrase: string, deviceId: string | undefined) => string | undefined
  /** The form's phrases now (draft) and as last saved: what "Added" / "Saved" is derived from. */
  readonly phrases?: ReadonlyArray<string>
  readonly savedPhrases?: ReadonlyArray<string>
}) {
  const client = useClient()
  const heard = useClientState((s) => s.heard)
  const phrases = draftPhrases
  /** "Listen to": a device id, or "" for the most recently active session. */
  const [chosen, setChosen] = useState(deviceId ?? "")
  const choices = useClientState(
    (s) => s.sessions.flatMap((x) => (x.deviceId === undefined ? [] : [`${x.deviceId}\u0000${x.name}`])),
    shallowEqual
  )
  const owner = useClientState(
    (s) => {
      const session = chosen !== ""
        ? s.sessions.find((x) => x.deviceId === chosen)
        : s.sessions.find((x) => x.ownerPresent)
      // A server that lists no sessions: the device that has the audio.
      const id = session !== undefined ? session.deviceId : s.sessions.length === 0 ? s.devices.find((x) => x.audioOwner)?.id : undefined
      if (session === undefined && id === undefined) return undefined
      const d = s.devices.find((x) => x.id === id)
      return { id: d?.id, name: d?.name ?? session?.name ?? "another device" }
    },
    shallowEqual
  )
  /**
   * The assistant a matched line woke, worked out once, when the line is first shown, from the tested device's
   * settings then: saving other assignments later does not relabel a line the server judged with the old ones.
   */
  const wokeOf = useRef(new WeakMap<HeardLine, string | undefined>())
  const wokeBy = (l: HeardLine): string | undefined => {
    if (l.matched === undefined || wakes === undefined) return undefined
    if (!wokeOf.current.has(l)) wokeOf.current.set(l, wakes(l.matched, owner?.id))
    return wokeOf.current.get(l)
  }
  const unsaved = useClientState((s) => s.ui.settingsDirty)
  const [until, setUntil] = useState<number | undefined>()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  /** Lines whose phrase was added here: the phrase. An error keeps the line out of it. */
  const [added, setAdded] = useState<Record<number, string>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})
  const focusAt = useRef<number | undefined>(undefined)
  const listRef = useRef<HTMLUListElement>(null)
  // After Add the button is gone: focus moves to the "Added" status of the same line, so it is not lost.
  useLayoutEffect(() => {
    if (focusAt.current === undefined) return
    listRef.current?.querySelector<HTMLElement>(`[data-added-at="${focusAt.current}"]`)?.focus()
    focusAt.current = undefined
  })
  const [announcement, setAnnouncement] = useState("")
  const on = until !== undefined
  const onRef = useRef(false)
  onRef.current = on

  const stop = async () => {
    setUntil(undefined)
    setAnnouncement("Phrase tester off.")
    await client.wakeTest(false) // continuation(none): nothing after it
  }
  const start = async () => {
    setBusy(true)
    client.store.dispatch({ type: "local/heard-clear" })
    setAdded({})
    setErrors({})
    const result = await client.wakeTest(true, chosen === "" ? undefined : chosen) // continuation(none): only this component's own state
    setBusy(false)
    if (result.ok) {
      setUntil(Date.now() + WAKE_TEST_MAX_MS)
      setAnnouncement("Phrase tester on for 5 minutes. New lines are read out as they come.")
    } else client.store.dispatch({ type: "local/toast", message: result.error?.message ?? "The tester did not start.", tone: "error" })
  }
  // The countdown, and off after 5 minutes (the server stops on its own too).
  useEffect(() => {
    if (until === undefined) return
    const timer = setInterval(() => { // continuation(none): the countdown and this component's own state
      const t = Date.now()
      setNow(t)
      if (t >= until) {
        setUntil(undefined)
        setAnnouncement("Phrase tester stopped after 5 minutes.")
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [until])
  // Each new heard line, with its result.
  const latest = heard[heard.length - 1]
  useEffect(() => {
    if (latest === undefined || !onRef.current) return
    setAnnouncement(`Heard “${latest.text}”: ${outcomeText(latest, wokeBy(latest)).toLowerCase()}.`)
  }, [latest])
  // Leaving the page stops it. When the session has ended (logout, restart) the server has already switched it off
  // and would refuse the request (`admin_required`), so nothing is sent then.
  useEffect(() => () => {
    if (onRef.current && client.store.get().admin.loggedIn) void client.wakeTest(false) // continuation(none): fire and forget on unmount
  }, [client])

  /** A different device while listening: its lines only from now on. */
  const choose = async (deviceId: string) => {
    setChosen(deviceId)
    if (!onRef.current) return
    client.store.dispatch({ type: "local/heard-clear" })
    setAdded({})
    setErrors({})
    const result = await client.wakeTest(true, deviceId === "" ? undefined : deviceId) // continuation(none): only a toast
    if (!result.ok) client.store.dispatch({ type: "local/toast", message: result.error?.message ?? "The tester could not switch devices.", tone: "error" })
  }

  const lines = [...heard].reverse()
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2/30 p-3" data-testid="phrase-tester" data-on={on ? "true" : "false"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
            <Icon name="ear" size={16} className="text-ink-muted" />
            Phrase tester
          </p>
          <p className="text-[13px] text-ink-muted" data-testid="tester-scope">
            {owner === undefined
              ? deviceId !== undefined
                ? `${on ? "Listening" : "Ready to listen"}${deviceName !== undefined ? ` to ${deviceName}` : ""}, but it has no voice page open now. Start talking on it.`
                : on
                ? "Listening, but no device has the audio. Start talking on a device."
                : "Say your phrase to a device and see what the recogniser heard."
              : <>{on ? "Testing" : "Ready to test"} {owner.name} with its saved settings.{on && <span className="tabular-nums"> Stops in {clock(Math.min(WAKE_TEST_MAX_MS, (until ?? now) - now))}.</span>}</>}
          </p>
        </div>
        {on ? (
          <Button size="md" className="max-sm:h-11" onClick={() => void stop()} data-testid="tester-stop">Stop</Button>
        ) : (
          <Button size="md" className="max-sm:h-11" variant="primary" onClick={() => void start()} disabled={busy} data-testid="tester-listen">
            {busy && <Spinner size={12} />}
            Listen
          </Button>
        )}
      </div>
      {deviceId === undefined && (choices.length > 1 || chosen !== "") && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label htmlFor="tester-device" className="text-[13px] text-ink-muted">Listen to</label>
          <select
            id="tester-device"
            data-testid="tester-device"
            value={chosen}
            onChange={(e) => void choose(e.target.value)}
            className={cx(inputClass, "w-auto min-w-0 max-w-full flex-1 max-sm:h-11 sm:flex-none")}
          >
            <option value="">The device talking most recently</option>
            {choices.map((c) => {
              const [deviceId, name] = c.split("\u0000") as [string, string]
              return <option key={deviceId} value={deviceId}>{name}</option>
            })}
            {chosen !== "" && !choices.some((c) => c.startsWith(`${chosen}\u0000`)) && <option value={chosen}>A device without a session now</option>}
          </select>
        </div>
      )}
      {unsaved && (
        <p className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-[13px] text-ink" data-testid="tester-unsaved">
          Your unsaved changes on this page are not tested until you save them.
        </p>
      )}
      <p className="sr-only" aria-live="polite" data-testid="tester-announcer">{announcement}</p>
      {(on || lines.length > 0) && (
        lines.length === 0 ? (
          <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[13px] text-ink-muted">Nothing heard yet.</p>
        ) : (
          <ul className="flex max-h-72 flex-col divide-y divide-line/60 overflow-y-auto rounded-md border border-line bg-surface scrollbar-quiet" ref={listRef} aria-label="Heard, newest first" data-testid="heard-lines">
            {lines.map((l) => {
              const phrase = phraseFromHeard(l.text, phrases)
              const outcome = heardOutcome(l)
              return (
                <li key={`${l.at}-${l.text}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-matched={outcome === "matched" ? "true" : "false"} data-outcome={outcome}>
                  <span className="min-w-0 flex-1 basis-full text-[14px] text-ink sm:basis-0">“{l.text}”</span>
                  {outcome === "matched" ? (
                    <span className="inline-flex items-center gap-1 text-[12px] text-ok">
                      <Icon name="check" size={14} />
                      {outcomeText(l, wokeBy(l))}
                    </span>
                  ) : outcome === "accepted" ? (
                    <span className="inline-flex items-center gap-1 text-[12px] text-you" title="Always listening, or the device was already listening (after the phrase or a reply)">
                      <Icon name="check" size={14} />
                      {outcomeText(l, wokeBy(l))}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <span className="label text-[10px] text-ink-muted">{outcomeText(l, wokeBy(l))}</span>
                      {onAdd === undefined ? null : added[l.at] !== undefined && listHas(draftPhrases, added[l.at]!) ? (
                        // Derived from the form: in the draft only = not saved yet; also in the saved list = saved.
                        <span tabIndex={-1} data-added-at={l.at} className="text-[12px] text-ok outline-none focus-visible:underline" data-testid="added-status">
                          {listHas(savedPhrases, added[l.at]!) ? `Saved “${added[l.at]}”` : `Added “${added[l.at]}”, not saved yet`}
                        </span>
                      ) : (
                        <>
                          {errors[l.at] !== undefined && <span className="text-[12px] text-danger" data-testid="add-error">{errors[l.at]}</span>}
                          <Button
                            size="sm"
                            onClick={() => {
                              const problem = onAdd?.(phrase)
                              if (problem !== undefined) {
                                setErrors((e) => ({ ...e, [l.at]: problem }))
                                setAnnouncement(`Not added: ${problem}`)
                                return
                              }
                              setErrors((e) => {
                                const { [l.at]: _gone, ...rest } = e
                                return rest
                              })
                              setAdded((a) => ({ ...a, [l.at]: phrase }))
                              focusAt.current = l.at
                              setAnnouncement(`Added “${phrase}” as a wake phrase. Save to keep it.`)
                            }}
                            aria-label={`Add “${phrase}” as a wake phrase`}
                            data-testid="add-heard"
                          >
                            <Icon name="plus" size={14} />
                            Add “{phrase}”
                          </Button>
                        </>
                      )}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )
      )}
    </div>
  )
}
