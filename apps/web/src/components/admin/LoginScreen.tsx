"use client"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { shallowEqual } from "@/lib/store.ts"
import { retrySecondsLeft } from "@/lib/vault.ts"
import { useClient, useClientState } from "../context.tsx"
import { inputClass } from "../fields/types.ts"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { Button, cx, ToneDot } from "../ui/controls.tsx"
import { useHref } from "../useHref.ts"

const END_REASON: Record<string, string> = {
  logout: "You logged out.",
  expired: "Your session ended after 12 hours. Log in again.",
  idle: "You were logged out after 30 minutes without changes.",
  token: "Your session ended (the assistant was restarted, or you logged out elsewhere). Log in again."
}

/** Seconds left while login attempts are refused; restarts with every `admin.state`. */
const useLoginWait = (): number => {
  const retryAfterMs = useClientState((s) => s.admin.retryAfterMs)
  const seq = useClientState((s) => s.adminSeq)
  const [receivedAt, setReceivedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setReceivedAt(Date.now())
    setNow(Date.now())
    if (retryAfterMs === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 250) // continuation(none): only this countdown's clock
    return () => clearInterval(timer)
  }, [retryAfterMs, seq])
  return retrySecondsLeft(retryAfterMs, receivedAt, now)
}

/**
 * The admin login (docs/FRONTENDS-AND-ACTIVATION.md §5): the password, a wrong-password message, the back-off
 * countdown, why a session ended, and — when the assistant has no admin password — how to set one.
 */
export function LoginScreen() {
  const v = useClientState(
    (s) => ({
      status: s.connection.status,
      everConnected: s.connection.everConnected,
      attempt: s.connection.attempt,
      enabled: s.admin.enabled,
      loggedIn: s.admin.loggedIn,
      endReason: s.admin.endReason
    }),
    shallowEqual
  )
  const voice = useHref("/")
  const connected = v.status === "open"
  return (
    <main className="fixed inset-0 overflow-y-auto bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]" data-testid="admin-login">
      <div className="mx-auto flex min-h-full w-full max-w-[420px] flex-col justify-center gap-6 px-4 py-10 sm:px-0">
        <div className="flex flex-col gap-2 px-1">
          <span className="label text-ink-faint">PVA · Admin</span>
          <h1 className="text-[24px] font-medium leading-tight text-ink">Assistant settings</h1>
        </div>
        <div className="rounded-lg border border-line bg-surface p-5 shadow-panel sm:p-6">
          {v.status === "outdated" ? (
            <div role="alert" className="flex flex-col gap-3">
              <p className="text-[15px] text-ink">This page is older than the assistant.</p>
              <Button variant="primary" onClick={() => location.reload()}><Icon name="reload" size={18} /> Reload</Button>
            </div>
          ) : !connected ? (
            <div className="flex items-center gap-3 text-[14px] text-ink-muted" role="status" data-testid="login-connecting">
              <Spinner className="text-ink-faint" />
              {v.everConnected ? `Reconnecting to the assistant · attempt ${v.attempt}` : "Connecting to the assistant…"}
            </div>
          ) : !v.enabled ? (
            <Disabled />
          ) : v.loggedIn ? (
            <div className="flex items-center gap-3 text-[14px] text-ink-muted" role="status">
              <Spinner className="text-ink-faint" />
              Loading the settings…
            </div>
          ) : (
            <LoginForm endReason={v.endReason} />
          )}
        </div>
        <a href={voice} className="inline-flex min-h-11 items-center gap-2 self-start px-1 text-[14px] text-ink-muted underline-offset-4 transition-colors hover:text-ink hover:underline">
          <Icon name="back" size={16} />
          Back to the voice assistant
        </a>
      </div>
    </main>
  )
}

function Disabled() {
  return (
    <div className="flex flex-col gap-3" data-testid="admin-disabled">
      <h2 className="flex items-center gap-2 text-[16px] font-medium text-ink">
        <ToneDot tone="warning" className="size-2" />
        Admin is switched off
      </h2>
      <p className="text-[14px] text-ink-muted">
        The assistant has no admin password, so nothing can be changed from a browser. To switch admin on, add a password of at least 8
        characters to <code className="font-mono text-[13px] text-ink">.env</code> and restart the assistant:
      </p>
      <pre className="overflow-x-auto rounded-md border border-line bg-surface-2/60 px-3 py-2.5 font-mono text-[13px] text-ink scrollbar-quiet">PVA_ADMIN_PASSWORD=…</pre>
    </div>
  )
}

function LoginForm({ endReason }: { readonly endReason: string | undefined }) {
  const client = useClient()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const wait = useLoginWait()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password === "") return setError("Type the admin password.")
    if (wait > 0 || busy) return
    setBusy(true)
    setError(undefined)
    const result = await client.adminLogin(password) // continuation(none): shows this request's own outcome
    setBusy(false)
    if (result.ok) return
    setError(result.error?.code === "bad_password" ? "That password is not right." : result.error?.message ?? "The login failed.")
    input.current?.focus()
    input.current?.select()
  }
  // Screen readers hear the back-off twice: when it starts (with its full length) and when trying is possible again.
  // The ticking number is not in the live region.
  const waitingFor = useClientState((s) => s.admin.retryAfterMs)
  const seq = useClientState((s) => s.adminSeq)
  const [announcement, setAnnouncement] = useState("")
  const waited = useRef(false)
  useEffect(() => {
    if (waitingFor === undefined || waitingFor <= 0) return
    waited.current = true
    setAnnouncement(`Too many wrong passwords. You can try again in ${Math.ceil(waitingFor / 1000)} seconds.`)
  }, [waitingFor, seq])
  useEffect(() => {
    if (wait === 0 && waited.current) {
      waited.current = false
      setAnnouncement("You can try the password again now.")
    }
  }, [wait])
  const reason = endReason === undefined ? undefined : END_REASON[endReason]
  // During the back-off one message says it all: the countdown replaces "That password is not right."
  const shownError = wait > 0 ? undefined : error
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" data-testid="login-form" noValidate>
      {reason !== undefined && (
        <p role="status" className="rounded-md border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-ink-muted" data-testid="login-reason">{reason}</p>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="admin-password" className="text-[14px] font-medium text-ink">Admin password</label>
        <input
          ref={input}
          id="admin-password"
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          value={password}
          // readOnly, not disabled: a disabled input drops focus, and typing again must work without a click.
          readOnly={busy}
          aria-busy={busy || undefined}
          aria-invalid={shownError !== undefined}
          aria-describedby={wait > 0 ? "login-wait" : shownError !== undefined ? "login-error" : "login-help"}
          onChange={(e) => setPassword(e.target.value)}
          className={cx(inputClass, "h-11")}
        />
        <p id="login-help" className="text-[12px] text-ink-faint">
          <code className="font-mono">PVA_ADMIN_PASSWORD</code> from the assistant's <code className="font-mono">.env</code>.
        </p>
      </div>
      {shownError !== undefined && <p id="login-error" role="alert" className="text-[13px] text-danger" data-testid="login-error">{shownError}</p>}
      {wait > 0 && (
        <p id="login-wait" className="text-[13px] text-warn" data-testid="login-wait">
          Too many wrong passwords. Try again in <span className="tabular-nums">{wait}</span> s.
        </p>
      )}
      <p className="sr-only" aria-live="polite" data-testid="login-announcer">{announcement}</p>
      <Button type="submit" variant="primary" className="h-11 w-full" disabled={busy || wait > 0}>
        {busy && <Spinner size={14} />}
        {wait > 0 ? `Wait ${wait} s` : "Log in"}
      </Button>
    </form>
  )
}
