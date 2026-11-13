"use client"
import { type FormEvent, useEffect, useState } from "react"
import { shallowEqual } from "@/lib/store.ts"
import { KEYS_TAB, keysView, newPasswordProblem, passwordProblem, retrySecondsLeft } from "@/lib/vault.ts"
import { useClient, useClientState } from "./context.tsx"
import { inputClass } from "./fields/types.ts"
import { Icon, Spinner } from "./ui/Icon.tsx"
import { Button, cx } from "./ui/controls.tsx"

/**
 * "Keys & access": the key vault's controls for this page. Self-contained
 * (reads `ClientState.vault`, calls the client's vault actions), so any screen
 * can place it; today it is the options drawer's Keys & access tab.
 */
export function KeysPanel() {
  const vault = useClientState((s) => s.vault, shallowEqual)
  const view = keysView(vault)
  return (
    <div className="flex flex-col gap-5" data-testid="keys-panel" data-view={view}>
      {vault.importedLegacySecrets !== undefined && vault.importedLegacySecrets > 0 && (
        <p role="status" className="rounded-md border border-ok/40 bg-ok/5 px-3 py-2 text-[13px] text-ink">
          {vault.importedLegacySecrets} key{vault.importedLegacySecrets === 1 ? " was" : "s were"} moved out of the project into the encrypted vault, and
          {" "}data/secrets.json was deleted.
        </p>
      )}
      {view === "setup" && <SetupForm />}
      {view === "unlock" && (
        <section className="flex flex-col gap-3">
          <Heading icon="lock" title="Keys are locked" />
          <p className="text-[13px] text-ink-muted">
            The assistant was restarted. Type the password so the engines and modules can use their keys again; this page can then also
            change protected settings.
          </p>
          <UnlockForm label="Unlock" />
        </section>
      )}
      {view === "elevate" && (
        <section className="flex flex-col gap-3">
          <Heading icon="lock" title="Keys are unlocked" />
          <p className="text-[13px] text-ink-muted">
            The assistant can use its keys. To change providers, keys or agents from this page, type the password.
          </p>
          <UnlockForm label="Get edit access" />
        </section>
      )}
      {view === "admin" && <AdminControls />}
      {vault.location !== undefined && (
        <p className="text-[12px] text-ink-faint">
          Vault file: <span className="break-all font-mono">{vault.location}</span>. Forgot the password? Delete that file; the keys in it are lost and
          you enter them again.
        </p>
      )}
    </div>
  )
}

/** The options tab (one line in `ui/registry.ts`). */
export function KeysTab() {
  return <KeysPanel />
}

function Heading({ icon, title }: { readonly icon: "lock"; readonly title: string }) {
  return (
    <h3 className="flex items-center gap-2 text-[15px] font-medium text-ink">
      <Icon name={icon} size={16} className="text-ink-muted" />
      {title}
    </h3>
  )
}

function PasswordInput(props: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (v: string) => void
  readonly autoComplete: "current-password" | "new-password"
  readonly disabled?: boolean
  readonly invalid?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-[14px] font-medium text-ink">{props.label}</label>
      <input
        id={props.id}
        type="password"
        autoComplete={props.autoComplete}
        spellCheck={false}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.invalid}
        onChange={(e) => props.onChange(e.target.value)}
        className={inputClass}
      />
    </div>
  )
}

function ErrorLine({ message }: { readonly message: string | undefined }) {
  return message === undefined ? null : <p role="alert" className="text-[13px] text-danger">{message}</p>
}

/** Seconds left while unlock attempts are refused (too many wrong passwords). */
function useRetryCountdown(): number {
  const retryAfterMs = useClientState((s) => s.vault.retryAfterMs)
  const [receivedAt, setReceivedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setReceivedAt(Date.now())
    setNow(Date.now())
    if (retryAfterMs === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [retryAfterMs])
  return retrySecondsLeft(retryAfterMs, receivedAt, now)
}

/** Password + button: unlocks the vault (or gives this page edit access when it is already unlocked). Also used by the engine banner. */
export function UnlockForm({ label = "Unlock", compact = false }: { readonly label?: string; readonly compact?: boolean }) {
  const client = useClient()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const wait = useRetryCountdown()
  const id = compact ? "unlock-password-banner" : "unlock-password"
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(password)
    if (problem !== undefined) return setError(problem)
    setBusy(true)
    setError(undefined)
    const result = await client.unlockVault(password)
    setBusy(false)
    if (result.ok) setPassword("")
    else setError(result.error?.message ?? "The vault did not unlock.")
  }
  return (
    <form onSubmit={(e) => void submit(e)} className={cx("flex flex-col gap-2", compact && "sm:flex-row sm:items-end")} data-testid={compact ? "unlock-form-banner" : "unlock-form"}>
      <div className={cx(compact && "min-w-0 flex-1")}>
        {compact ? (
          <input
            id={id}
            type="password"
            autoComplete="current-password"
            aria-label="Vault password"
            placeholder="Password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        ) : (
          <PasswordInput id={id} label="Password" value={password} onChange={setPassword} autoComplete="current-password" disabled={busy} invalid={error !== undefined} />
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size={compact ? "md" : "sm"} disabled={busy || wait > 0}>
          {busy && <Spinner size={12} />}
          {wait > 0 ? `${label} (${wait} s)` : label}
        </Button>
      </div>
      <ErrorLine message={error} />
    </form>
  )
}

function SetupForm() {
  const client = useClient()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const problem = newPasswordProblem(password, confirm)
    if (problem !== undefined) return setError(problem)
    setBusy(true)
    setError(undefined)
    const result = await client.setupVault(password)
    setBusy(false)
    if (result.ok) {
      setPassword("")
      setConfirm("")
    } else setError(result.error?.message ?? "The vault was not created.")
  }
  return (
    <section className="flex flex-col gap-3" data-testid="vault-setup">
      <Heading icon="lock" title="Protect your keys" />
      <p className="text-[13px] text-ink-muted">
        API keys are now stored unencrypted in the project folder, and anyone who opens this page can change providers and keys. Set a password:
        the keys move out of the project into an encrypted file, and only a page where the password was typed can change keys, providers and
        agents. You type the password again after every restart of the assistant.
      </p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <PasswordInput id="vault-new" label="New password" value={password} onChange={setPassword} autoComplete="new-password" disabled={busy} />
        <PasswordInput id="vault-confirm" label="Type it again" value={confirm} onChange={setConfirm} autoComplete="new-password" disabled={busy} />
        <ErrorLine message={error} />
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy && <Spinner size={12} />}
            Set password
          </Button>
        </div>
      </form>
    </section>
  )
}

function AdminControls() {
  const client = useClient()
  const [changing, setChanging] = useState(false)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const lock = async () => {
    setBusy(true)
    const result = await client.lockVault()
    setBusy(false)
    if (!result.ok) client.store.dispatch({ type: "local/toast", message: result.error?.message ?? "The vault was not locked.", tone: "error" })
  }
  const change = async (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(current) ?? newPasswordProblem(next, confirm)
    if (problem !== undefined) return setError(problem)
    setBusy(true)
    setError(undefined)
    const result = await client.changeVaultPassword(current, next)
    setBusy(false)
    if (!result.ok) return setError(result.error?.message ?? "The password was not changed.")
    setCurrent("")
    setNext("")
    setConfirm("")
    setChanging(false)
    setDone(true)
  }
  return (
    <section className="flex flex-col gap-3" data-testid="vault-admin">
      <Heading icon="lock" title="Keys are unlocked" />
      <p className="text-[13px] text-ink-muted">
        This page can change keys, providers and agents. Access ends when you close the page, lock, or after 15 minutes without a change.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void lock()} disabled={busy}>Lock now</Button>
        {!changing && <Button size="sm" variant="quiet" onClick={() => {
          setChanging(true)
          setDone(false)
        }}>Change password</Button>}
        {done && <span className="text-[12px] text-ok" aria-live="polite">Password changed</span>}
      </div>
      <p className="text-[12px] text-ink-faint">Lock now removes the keys from memory for every page; running engines keep the keys they started with until they are reloaded.</p>
      {changing && (
        <form onSubmit={(e) => void change(e)} className="flex flex-col gap-3 rounded-md border border-line/70 p-3">
          <PasswordInput id="vault-current" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" disabled={busy} />
          <PasswordInput id="vault-next" label="New password" value={next} onChange={setNext} autoComplete="new-password" disabled={busy} />
          <PasswordInput id="vault-next-confirm" label="Type the new one again" value={confirm} onChange={setConfirm} autoComplete="new-password" disabled={busy} />
          <ErrorLine message={error} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy && <Spinner size={12} />}Change password</Button>
            <Button size="sm" variant="quiet" onClick={() => setChanging(false)} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )}
    </section>
  )
}

/** "Locked" chip and an "Unlock to change" link to the Keys & access place, for a protected item this page may not change. */
export function LockedBadge({ name }: { readonly name: string }) {
  const client = useClient()
  const open = () => client.store.dispatch({ type: "local/ui", patch: { optionsOpen: true, optionsTab: KEYS_TAB } })
  return (
    <span className="inline-flex items-center gap-2" data-testid="locked-badge">
      <span className="label inline-flex items-center gap-1 text-[10px] text-ink-faint" title="Protected: needs the vault password">
        <Icon name="lock" size={11} />
        Locked
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          open()
        }}
        aria-label={`Unlock to change ${name}`}
        className="text-[12px] text-voice underline-offset-4 hover:underline"
      >
        Unlock to change
      </button>
    </span>
  )
}
