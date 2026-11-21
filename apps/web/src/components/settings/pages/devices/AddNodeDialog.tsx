"use client"
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react"
import { MAX_DEVICE_NAME_CHARS, type NodePairing, VOICE_NODE_KIND } from "@pva/protocol"
import { resolveWsUrl } from "@/lib/connection.ts"
import { countdownText, formatPairCode, installCommand, parsePin, parseServerAddress, serverOriginOf } from "@/lib/nodes.ts"
import { typePageId } from "@/lib/settingsTree.ts"
import { useClient, useClientState } from "../../../context.tsx"
import { inputClass } from "../../../fields/types.ts"
import { Icon, Spinner } from "../../../ui/Icon.tsx"
import { useDialog } from "../../../ui/Panel.tsx"
import { Button, cx, IconButton } from "../../../ui/controls.tsx"
import { Callout, DField } from "./parts.tsx"
import { copyText } from "@/lib/clipboard.ts"

/**
 * Add voice node (docs/VOICE-NODES.md §7.3): a node cannot connect before it is paired, so this dialog takes the owner
 * through it at the box: 1. a name and the server address the box uses, 2. a one-time code with the command to run on
 * the box (`node.pair.create`; Cancel sends `node.pair.cancel`), 3. paired, when the server says the box redeemed the
 * code (`node.paired`).
 */

type Step = "address" | "code" | "paired"
const STEPS: ReadonlyArray<{ readonly id: Step; readonly title: string }> = [
  { id: "address", title: "Address" },
  { id: "code", title: "Code" },
  { id: "paired", title: "Paired" }
]

/** The page's server, as the box would reach it (the WebSocket address the page uses, as http(s)). */
const defaultAddress = (): string => {
  if (typeof window === "undefined") return ""
  return serverOriginOf(resolveWsUrl(window.location), window.location.origin)
}

export function AddNodeDialog({ onClose }: { readonly onClose: () => void }) {
  const client = useClient()
  const ref = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [name, setName] = useState("")
  const [address, setAddress] = useState(defaultAddress)
  const [pairing, setPairing] = useState<NodePairing | undefined>()
  /** The name the live code was made with: a different one needs a new code. */
  const [pairedAs, setPairedAs] = useState("")
  const [step, setStep] = useState<Step>("address")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [now, setNow] = useState(() => Date.now())
  const paired = useClientState((s) => (pairing === undefined ? undefined : s.pairedNodes.find((p) => p.code === pairing.code)))
  const nodeType = useClientState((s) => s.deviceTypes.find((t) => t.kind === VOICE_NODE_KIND))
  const nobodyAnswers = nodeType !== undefined && nodeType.settings.assistants.length === 0
  const shownStep: Step = paired !== undefined ? "paired" : step
  const expired = pairing !== undefined && paired === undefined && now >= pairing.expiresAt
  const live = pairing !== undefined && paired === undefined && !expired

  // The code outstanding when the dialog goes (closed, Escape, navigated away) is cancelled on the server.
  const outstanding = useRef<string | undefined>(undefined)
  outstanding.current = live ? pairing.code : undefined
  useEffect(() => () => {
    if (outstanding.current !== undefined) void client.nodePairCancel(outstanding.current) // continuation(none): best effort
  }, [client])
  const close = () => {
    if (outstanding.current !== undefined) void client.nodePairCancel(outstanding.current) // continuation(none): best effort
    outstanding.current = undefined
    onClose()
  }
  useDialog(ref, true, close, "#node-name", { inertBackground: true })

  useEffect(() => {
    if (shownStep !== "code" || pairing === undefined) return
    const t = setInterval(() => setNow(Date.now()), 1000) // continuation(none): only the countdown
    return () => clearInterval(t)
  }, [shownStep, pairing])
  // A new step is announced and takes the focus (its heading), so a screen reader and the keyboard follow.
  useEffect(() => {
    if (shownStep !== "address") headingRef.current?.focus({ preventScroll: true })
  }, [shownStep])

  const parsed = parseServerAddress(address)
  const getCode = async (fresh = false) => {
    setError(undefined)
    if (!parsed.ok) return
    if (!fresh && live && pairedAs === name.trim()) return setStep("code")
    if (live) void client.nodePairCancel(pairing.code) // continuation(none): the old code goes; a new one follows
    setBusy(true)
    try {
      const r = await client.nodePairCreate({ name }) // continuation(state): the dialog may have closed; its state is its own
      if (r.ok && r.pairing !== undefined) {
        setPairing(r.pairing)
        setPairedAs(name.trim())
        setNow(Date.now())
        setStep("code")
      } else setError(r.error?.message ?? "No code: the server did not answer with one.")
    } catch {
      setError("No code: the connection to the server dropped. Try again.")
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void getCode()
  }
  const again = () => {
    setPairing(undefined)
    setPairedAs("")
    setName("")
    setError(undefined)
    setStep("address")
  }

  const index = STEPS.findIndex((s) => s.id === shownStep)
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-bg/70 p-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:items-center" data-testid="add-node">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-node-title"
        className="flex max-h-[calc(100dvh-32px)] w-full max-w-[560px] flex-col overflow-y-auto rounded-lg border border-line bg-surface p-5 shadow-panel"
        data-step={shownStep}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="add-node-title" className="text-[16px] font-medium text-ink">Add a voice node</h2>
            <ol className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]" aria-label="Steps" data-testid="add-node-steps">
              {STEPS.map((s, i) => (
                <li key={s.id} className={cx("inline-flex items-center gap-1", i === index ? "text-voice" : i < index ? "text-ink-muted" : "text-ink-faint")} aria-current={i === index ? "step" : undefined}>
                  <span className="font-mono">{i + 1}</span> {s.title}
                </li>
              ))}
            </ol>
          </div>
          <IconButton label="Close" onClick={close} className="-mr-2 -mt-2 shrink-0" data-testid="add-node-close">
            <Icon name="close" size={16} />
          </IconButton>
        </div>

        {shownStep === "address" && (
          <form className="mt-4 flex flex-col gap-5" onSubmit={submit} data-testid="add-node-address">
            <p className="text-[14px] text-ink-muted">
              A voice node is a small box with a microphone and a speaker, such as a Raspberry Pi. You get a one-time code and a command to run on the box: have a terminal on it ready.
            </p>
            <DField label="Name" htmlFor="node-name" help="How it is listed here. Empty: the box's host name. You can change it later.">
              <input id="node-name" value={name} maxLength={MAX_DEVICE_NAME_CHARS} placeholder="the box's host name" autoComplete="off" onChange={(e) => setName(e.target.value)} className={inputClass} />
            </DField>
            <DField
              label="Server address the node uses"
              htmlFor="node-server"
              help="How the box reaches this server on your network: such as http://192.168.1.20:8787 or https://assistant.home."
              {...(!parsed.ok && address.trim() !== "" ? { error: parsed.message } : {})}
            >
              <input
                id="node-server"
                value={address}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setAddress(e.target.value)}
                aria-invalid={!parsed.ok || undefined}
                className={cx(inputClass, "font-mono text-[13px]")}
                data-testid="node-server"
              />
            </DField>
            {parsed.ok && parsed.loopback && (
              <Callout tone="warn" testId="address-loopback">
                <p>On the box, {new URL(parsed.url).hostname} is the box itself. Use this server's name or its address on your network.</p>
              </Callout>
            )}
            {parsed.ok && !parsed.secure && (
              <p className="-mt-2 text-[13px] text-ink-muted" data-testid="address-plain">The node's sound and its key travel unencrypted on your network.</p>
            )}
            {error !== undefined && <p role="alert" className="text-[13px] text-danger" data-testid="add-node-error">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" className="max-sm:h-11" onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" className="max-sm:h-11" disabled={!parsed.ok || busy} data-testid="get-code">
                {busy && <Spinner size={12} />}
                {live && pairedAs === name.trim() ? "Back to the code" : "Get code"}
              </Button>
            </div>
          </form>
        )}

        {shownStep === "code" && pairing !== undefined && parsed.ok && (
          <CodeStep
            pairing={pairing}
            url={parsed.url}
            secure={parsed.secure}
            now={now}
            expired={expired}
            busy={busy}
            error={error}
            nobodyAnswers={nobodyAnswers}
            headingRef={headingRef}
            dialog={ref}
            onChangeAddress={() => setStep("address")}
            onNewCode={() => void getCode(true)}
            onCancel={close}
          />
        )}

        {shownStep === "paired" && paired !== undefined && (
          <section className="mt-4 flex flex-col gap-4" aria-labelledby="add-node-paired" data-testid="add-node-paired">
            <h3 id="add-node-paired" ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-[16px] text-ink outline-none">
              <Icon name="check" size={18} className="text-ok" />
              {paired.name} is paired.
            </h3>
            {nobodyAnswers ? (
              <Callout tone="warn" testId="nobody-answers">
                <p>Nobody answers on voice nodes yet, so it listens but does not answer. Choose who answers on Every voice node.</p>
              </Callout>
            ) : (
              <p className="text-[14px] text-ink-muted">
                It follows Every voice node: {nodeType?.settings.assistants.length === 1 ? "one assistant answers" : `${nodeType?.settings.assistants.length ?? 0} assistants answer`} there, one answer per wake phrase. Its page shows its status, tests and its own settings.
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" className="max-sm:h-11" onClick={again} data-testid="add-another">Add another</Button>
              {nobodyAnswers && (
                <Button className="max-sm:h-11" onClick={() => {
                  onClose()
                  client.settings(["devices", typePageId(VOICE_NODE_KIND)])
                }} data-testid="choose-who-answers">Choose who answers</Button>
              )}
              <Button variant="primary" className="max-sm:h-11" onClick={() => {
                onClose()
                client.settings(["devices", paired.deviceId])
              }} data-testid="open-node">Open its page</Button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function CodeStep({ pairing, url, secure, now, expired, busy, error, nobodyAnswers, headingRef, dialog, onChangeAddress, onNewCode, onCancel }: {
  readonly pairing: NodePairing
  readonly url: string
  readonly secure: boolean
  readonly now: number
  readonly expired: boolean
  readonly busy: boolean
  readonly error: string | undefined
  readonly nobodyAnswers: boolean
  readonly headingRef: RefObject<HTMLHeadingElement | null>
  readonly dialog: RefObject<HTMLDivElement | null>
  readonly onChangeAddress: () => void
  readonly onNewCode: () => void
  readonly onCancel: () => void
}) {
  const [pinText, setPinText] = useState("")
  const [copied, setCopied] = useState<"yes" | "no" | undefined>()
  const pasted = pinText.trim() === "" ? undefined : parsePin(pinText)
  const pin = secure ? pairing.tlsPin ?? pasted : undefined
  const command = installCommand({ url, code: pairing.code, pin })
  const httpsMismatch = pairing.tls && !secure
  const copy = () => {
    // continuation(none): only the "Copied" line
    void copyText(command, dialog.current).then((ok) => setCopied(ok ? "yes" : "no"))
  }
  return (
    <section className="mt-4 flex flex-col gap-4" aria-labelledby="add-node-code" data-testid="add-node-code">
      <h3 id="add-node-code" ref={headingRef} tabIndex={-1} className="sr-only">The code and the command</h3>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <p className="text-[12px] text-ink-muted">One-time code</p>
          <p className={cx("font-mono text-[32px] font-medium leading-none tracking-[0.08em]", expired ? "text-ink-faint line-through" : "text-ink")} data-testid="pair-code" aria-label={`Code ${pairing.code.split("").join(" ")}`}>
            {formatPairCode(pairing.code)}
          </p>
        </div>
        <p className={cx("text-[13px]", expired ? "text-warn" : "text-ink-muted")} data-testid="pair-countdown" aria-live="off">
          {expired ? "The code expired." : `Expires in ${countdownText(pairing.expiresAt - now)}`}
        </p>
      </div>
      {expired ? (
        <div className="flex flex-col items-start gap-2" data-testid="pair-expired">
          <p className="text-[14px] text-ink-muted">A code works for 10 minutes and only once. Get a new one and run the command again with it.</p>
          <Button variant="primary" disabled={busy} onClick={onNewCode} data-testid="new-code">
            {busy && <Spinner size={12} />}
            New code
          </Button>
        </div>
      ) : (
        <>
          {pairing.loopbackOnly && (
            <Callout tone="warn" testId="pair-loopback">
              <p>This server listens on this machine only (SERVE_HOST is a loopback address), so the box cannot reach it. Set <span className="font-mono text-[12px]">SERVE_HOST=0.0.0.0</span> in the server's .env, restart the server, and get a new code.</p>
            </Callout>
          )}
          {httpsMismatch && (
            <Callout tone="warn" testId="pair-https">
              <p>This server serves https: the box cannot connect to an http:// address. <button type="button" className="text-voice underline-offset-4 hover:underline" onClick={onChangeAddress}>Change the address</button> to https://.</p>
            </Callout>
          )}
          {pairing.bundle === null ? (
            <Callout tone="warn" testId="pair-not-built">
              <p>The node program is not built on this server, so there is nothing to install yet.</p>
              <p>Run <span className="font-mono text-[12px]">pnpm --filter @pva/node bundle</span> on the server (or restart it with <span className="font-mono text-[12px]">pnpm serve</span>), then try again.</p>
            </Callout>
          ) : (
            <>
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-[14px] text-ink-muted marker:text-ink-faint">
                <li>On the box, open a terminal (or connect with ssh).</li>
                <li>Run this command. It installs the node program and pairs the box with this code.</li>
                <li>Leave this open: it moves on by itself when the box is paired.</li>
              </ol>
              <div className="flex flex-col gap-2">
                <pre className="select-all whitespace-pre-wrap break-all rounded-md border border-line bg-surface-2/50 px-3 py-2.5 font-mono text-[12px] leading-[18px] text-ink" data-testid="install-command">{command}</pre>
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" onClick={copy} data-testid="copy-command">
                    <Icon name="copy" size={14} />
                    Copy command
                  </Button>
                  <span aria-live="polite" className="text-[13px] text-ink-muted" data-testid="copied">{copied === "yes" ? "Copied." : copied === "no" ? "Select the command and copy it." : ""}</span>
                </div>
                <p className="text-[13px] text-ink-muted">
                  Server address: <span className="font-mono text-[12px] text-ink">{url}</span>{" "}
                  <button type="button" className="text-voice underline-offset-4 hover:underline" onClick={onChangeAddress} data-testid="change-address">Change</button>
                  {pin !== undefined && <> · the certificate is checked by its pin</>}
                </p>
              </div>
              {secure && pairing.tlsPin === undefined && (
                <details className="group rounded-md border border-line/70 px-3 py-2" open={pinText !== "" || undefined} data-testid="pin-field">
                  <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-[14px] text-ink-muted marker:hidden hover:text-ink max-sm:min-h-11">
                    <Icon name="chevron" size={14} className="shrink-0 transition-transform duration-[120ms] group-open:rotate-90" />
                    Self-signed certificate behind a proxy? Paste its pin
                  </summary>
                  <div className="mt-3 pb-2">
                    <DField
                      label="Certificate pin"
                      htmlFor="node-pin"
                      help="The SHA-256 of the certificate's public key, as sha256:<hex> or curl's sha256//<base64>. A public certificate (such as Let's Encrypt) needs none."
                      {...(pinText.trim() !== "" && pasted === undefined ? { error: "This is not a SHA-256 pin." } : {})}
                    >
                      <input id="node-pin" value={pinText} onChange={(e) => setPinText(e.target.value)} autoComplete="off" spellCheck={false} className={cx(inputClass, "font-mono text-[13px]")} placeholder="sha256:…" />
                    </DField>
                  </div>
                </details>
              )}
              <p className="flex items-center gap-2 text-[14px] text-ink" aria-live="polite" data-testid="pair-waiting">
                <Spinner size={14} />
                Waiting for the node…
              </p>
            </>
          )}
          {nobodyAnswers && (
            <Callout testId="nobody-answers">
              <p>Nobody answers on voice nodes yet: there is no assistant on Every browser to start from. Choose who answers on Every voice node after pairing.</p>
            </Callout>
          )}
        </>
      )}
      {error !== undefined && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="quiet" className="max-sm:h-11" onClick={onCancel} data-testid="cancel-pairing">Cancel</Button>
      </div>
    </section>
  )
}
