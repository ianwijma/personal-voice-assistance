"use client"
import { type ReactNode, useState } from "react"
import type { AudioDeviceInfo, DeviceListInfo, NodeCommandName } from "@pva/protocol"
import { setKeys } from "@/lib/devices.ts"
import {
  BACKEND_NAMES,
  capabilitiesText,
  nodeOnlineText,
  packageFor,
  platformText,
  soundDeviceOptions,
  runsFromSource,
  unencrypted,
  updatePending
} from "@/lib/nodes.ts"
import { agoText } from "@/lib/sessions.ts"
import { useClient } from "../../../context.tsx"
import { inputClass } from "../../../fields/types.ts"
import { Icon, Spinner } from "../../../ui/Icon.tsx"
import { Button, cx, ToneDot } from "../../../ui/controls.tsx"
import { MarksFor, SELECT_STYLE, selectClass, type SectionContext } from "./AssignSection.tsx"
import { Chip, DField, Toggle } from "./parts.tsx"

/**
 * A voice node's own parts of the device page (docs/VOICE-NODES.md §7.2): its Status and Actions (a node's page only),
 * and the Sound and Sound devices sections (also on Every voice node), with the usual Own value · Reset marks.
 */

const nameOf = (list: ReadonlyArray<AudioDeviceInfo>, id: string): string => {
  const d = list.find((x) => x.id === id)
  return d === undefined || d.name === "" ? id : d.name
}

function Fact({ label, children, testId, tone }: { readonly label: string; readonly children: ReactNode; readonly testId?: string; readonly tone?: "warn" }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cx("min-w-0 [overflow-wrap:anywhere]", tone === "warn" ? "text-warn" : "text-ink")} data-testid={testId}>{children}</dd>
    </>
  )
}

/** Status (read only): online or since when not, version, box, audio, missing tools, connection, last error, what it can do. */
export function NodeStatusSection({ device, now, conversations }: { readonly device: DeviceListInfo; readonly now: number; readonly conversations: string }) {
  const node = device.node
  const status = node?.status
  const online = device.connections > 0
  const can = capabilitiesText(device.declared?.capabilities)
  return (
    <section className="flex flex-col gap-3" aria-labelledby="h-node-status" data-testid="node-status">
      <h3 id="h-node-status" className="label text-ink-faint">Status</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[13px]" data-testid="device-facts">
        <Fact label="Type">Voice node</Fact>
        <Fact label="Status" testId="device-status">
          <span className="inline-flex items-center gap-2">
            <ToneDot tone={online ? "ok" : "neutral"} />
            {nodeOnlineText(device, now)}
            {!online && ` (${agoText(device.lastSeen, now)})`}
          </span>
        </Fact>
        <Fact label="Version" testId="node-version">
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px]">{node?.version ?? "Not known yet"}</span>
            {updatePending(node) && <Chip tone="warn" testId="update-pending">Update pending</Chip>}
            {node?.upToDate === true && <span className="text-ink-muted">up to date</span>}
            {runsFromSource(device) && <span className="text-ink-muted">runs from source</span>}
          </span>
        </Fact>
        {node?.platform !== undefined && <Fact label="Box" testId="node-platform">{platformText(node.platform)}</Fact>}
        <Fact label="Audio" testId="node-audio">
          {status === undefined ? (
            <span className="text-ink-muted">Not reported yet: the node says when it connects.</span>
          ) : (
            <span className="flex flex-col gap-0.5">
              <span>{BACKEND_NAMES[status.backend]}</span>
              <span>
                <span className="text-ink-muted">Microphone: </span>
                {status.input !== undefined ? `${nameOf(status.inputs, status.input.opened)} · ${Math.round(status.input.sampleRate / 100) / 10} kHz` : "not open"}
              </span>
              <span>
                <span className="text-ink-muted">Speaker: </span>
                {status.output !== undefined ? nameOf(status.outputs, status.output.opened) : "not open"}
              </span>
            </span>
          )}
        </Fact>
        {status?.missingTools !== undefined && status.missingTools.length > 0 && (
          <Fact label="Missing" testId="node-missing" tone="warn">
            <span className="flex flex-col gap-0.5">
              {status.missingTools.map((t) => (
                <span key={t}>
                  <span className="font-mono text-[12px]">{t}</span>: install <span className="font-mono text-[12px]">{packageFor(t)}</span> on the box (<span className="font-mono text-[12px]">sudo apt install {packageFor(t)}</span>)
                </span>
              ))}
            </span>
          </Fact>
        )}
        {node?.transport !== undefined && (
          <Fact label="Connection" testId="node-transport">
            {unencrypted(node) ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <Chip tone="warn">Unencrypted</Chip>
                <span>Its sound and its key travel in the clear on your network (ws).</span>
              </span>
            ) : "Encrypted (wss)"}
          </Fact>
        )}
        {status?.lastError !== undefined && (
          <Fact label="Last error" testId="node-last-error" tone="warn">
            {status.lastError.message} <span className="text-ink-muted">· {agoText(status.lastError.at, now)}</span>
          </Fact>
        )}
        {can !== undefined && <Fact label="What it can do" testId="node-can">{can}</Fact>}
        <Fact label="Conversations" testId="device-conversation">{conversations}</Fact>
        {node !== undefined && <Fact label="Paired">{new Date(node.pairedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</Fact>}
      </dl>
    </section>
  )
}

const ACTION_SENT: Readonly<Record<NodeCommandName, (name: string) => string>> = {
  identify: (n) => `Sent. Listen: ${n} plays its chime.`,
  "test-speaker": (n) => `Sent. ${n} plays a short sound at its saved volume.`,
  "test-mic": (n) => `Sent to ${n}.`,
  restart: (n) => `Sent. ${n} restarts and is back in a few seconds.`,
  update: (n) => `Sent. ${n} downloads the new version from this server and restarts.`
}

/** Sends one command to the node and says what happened (`node.command.send`). */
const useNodeCommand = (device: DeviceListInfo) => {
  const client = useClient()
  const [busy, setBusy] = useState<NodeCommandName | undefined>()
  const [said, setSaid] = useState<{ readonly text: string; readonly tone: "ok" | "error" } | undefined>()
  const send = (command: NodeCommandName, durationMs?: number) => {
    setBusy(command)
    setSaid(undefined)
    // continuation(none): only this section's own state
    void client.nodeCommand(device.id, command, durationMs).then(
      (r) => {
        setBusy(undefined)
        setSaid(r.ok ? { text: ACTION_SENT[command](device.name), tone: "ok" } : { text: r.error?.message ?? "Not sent.", tone: "error" })
      },
      () => {
        setBusy(undefined)
        setSaid({ text: "Not sent: the connection to the server dropped. Try again.", tone: "error" })
      }
    )
  }
  return { busy, said, send }
}

function Said({ said }: { readonly said: { readonly text: string; readonly tone: "ok" | "error" } | undefined }) {
  return (
    <p aria-live="polite" className={cx("min-h-5 text-[13px]", said?.tone === "error" ? "text-danger" : "text-ink-muted")} data-testid="node-said">
      {said?.text ?? ""}
    </p>
  )
}

/** Actions: Identify, Test speaker, Restart, Update now (when an update is pending). Only while the node is online. */
export function NodeActions({ device }: { readonly device: DeviceListInfo }) {
  const online = device.connections > 0
  const { busy, said, send } = useNodeCommand(device)
  const button = (command: NodeCommandName, label: string, primary = false) => (
    <Button variant={primary ? "primary" : "default"} disabled={!online || busy !== undefined} onClick={() => send(command)} data-testid={`node-${command}`}>
      {busy === command && <Spinner size={12} />}
      {label}
    </Button>
  )
  return (
    <section className="flex flex-col gap-3" aria-labelledby="h-node-actions" data-testid="node-actions">
      <h3 id="h-node-actions" className="label text-ink-faint">Actions</h3>
      <p className="-mt-1 text-[13px] text-ink-muted">
        {online
          ? "Identify plays a chime, so you know which box this is. Test speaker plays a short sound at the saved volume."
          : "These work while the node is online."}
      </p>
      <div className="flex flex-wrap gap-2">
        {button("identify", "Identify")}
        {button("test-speaker", "Test speaker")}
        {button("restart", "Restart")}
        {updatePending(device.node) && button("update", "Update now", true)}
      </div>
      <Said said={said} />
    </section>
  )
}

/** Sound: the node's volume (with a test at the saved volume) and its cues. */
export function SoundSection({ ctx, device }: { readonly ctx: SectionContext; readonly device: DeviceListInfo | undefined }) {
  const sound = ctx.settings.sound
  const saved = ctx.base.saved.sound.volume
  const set = (next: typeof sound) => ctx.update((e) => setKeys(ctx.base, e, { sound: next }))
  return (
    <section className="flex flex-col gap-5" aria-labelledby="h-sound" data-testid="section-sound">
      <div className="flex items-baseline gap-2">
        <h3 id="h-sound" className="label text-ink-faint">Sound</h3>
        <MarksFor ctx={ctx} section="sound" title="Sound" />
      </div>
      <DField label="Volume" htmlFor="node-volume" help={`How loud replies and cues are on ${ctx.thisWord}. Applies at once after saving.`}>
        <div className="flex max-w-[460px] items-center gap-3">
          <input
            id="node-volume"
            type="range"
            min={0}
            max={100}
            step={1}
            value={sound.volume}
            aria-valuetext={`${sound.volume} %`}
            onChange={(e) => set({ ...sound, volume: Number(e.target.value) })}
            className="h-8 min-w-0 flex-1 cursor-pointer accent-[var(--color-voice)] max-sm:h-11"
            data-testid="node-volume"
          />
          <span className="w-12 shrink-0 text-right font-mono text-[13px] text-ink" data-testid="node-volume-value">{sound.volume} %</span>
          {device !== undefined && <SpeakerTest device={device} />}
        </div>
        {device !== undefined && sound.volume !== saved && <p className="text-[13px] text-ink-muted" data-testid="volume-unsaved">Test plays the saved volume ({saved} %). Save to hear {sound.volume} %.</p>}
      </DField>
      <DField label="Cues" help="A short sound when a wake phrase is heard, and when it stops listening. Identify always plays.">
        <Toggle label="Cues" checked={sound.cues} onChange={(v) => set({ ...sound, cues: v })} />
      </DField>
    </section>
  )
}

function SpeakerTest({ device }: { readonly device: DeviceListInfo }) {
  const { busy, said, send } = useNodeCommand(device)
  return (
    <span className="relative inline-flex shrink-0">
      <Button size="sm" disabled={device.connections === 0 || busy !== undefined} onClick={() => send("test-speaker", 1000)} title={device.connections === 0 ? "The node is offline." : "Plays a short sound at the saved volume."} data-testid="volume-test">
        {busy !== undefined ? <Spinner size={12} /> : <Icon name="speaker" size={14} />}
        Test
      </Button>
      {said?.tone === "error" && <span role="alert" className="sr-only">{said.text}</span>}
    </span>
  )
}

/**
 * Sound devices: which microphone and speaker. The choices are what the node reported (on Every voice node: every
 * node's), "System default", and a stored device that is not connected now, which stays as it is.
 */
export function SoundDevicesSection({ ctx, inputs, outputs }: {
  readonly ctx: SectionContext
  /** Undefined: no node has reported its devices yet. */
  readonly inputs: ReadonlyArray<AudioDeviceInfo> | undefined
  readonly outputs: ReadonlyArray<AudioDeviceInfo> | undefined
}) {
  const devices = ctx.settings.soundDevices
  const set = (next: typeof devices) => ctx.update((e) => setKeys(ctx.base, e, { soundDevices: next }))
  const unknown = inputs === undefined || outputs === undefined
  /** A stored device the node did not report: said under the select too, as a long id cuts its "(not connected)" off. */
  const gone = (which: "input" | "output", list: ReadonlyArray<AudioDeviceInfo> | undefined, word: string) =>
    list !== undefined && devices[which] !== "" && !list.some((d) => d.id === devices[which])
      ? { help: <span className="text-warn" data-testid={`node-${which}-gone`}>{devices[which]} is not connected now, so {ctx.isType ? "the nodes use their" : "the node uses its"} default {word}.</span> }
      : {}
  const select = (which: "input" | "output", list: ReadonlyArray<AudioDeviceInfo> | undefined, label: string) => (
    <select
      id={`node-${which}`}
      value={devices[which]}
      disabled={unknown}
      onChange={(e) => set({ ...devices, [which]: e.target.value })}
      className={cx(inputClass, selectClass, "max-w-[460px] disabled:opacity-60")}
      style={SELECT_STYLE}
      aria-label={label}
      data-testid={`node-${which}`}
    >
      {soundDeviceOptions(list ?? [], devices[which]).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
  return (
    <section className="flex flex-col gap-5" aria-labelledby="h-sound-devices" data-testid="section-soundDevices">
      <div className="flex items-baseline gap-2">
        <h3 id="h-sound-devices" className="label text-ink-faint">Sound devices</h3>
        <MarksFor ctx={ctx} section="soundDevices" title="Sound devices" />
      </div>
      <p className="-mt-2 text-[13px] text-ink-muted">
        {unknown
          ? ctx.isType ? "Connect a voice node to choose: the lists come from the nodes." : "Connect the node to choose: the list comes from the box."
          : ctx.isType
          ? "From the devices the voice nodes reported. Identical boxes report the same names, so one choice here fits them all."
          : "From the devices the box reported. A device that is not found falls back to the default and shows under Last error."}
      </p>
      <DField label="Microphone" htmlFor="node-input" {...gone("input", inputs, "microphone")}>{select("input", inputs, "Microphone")}</DField>
      <DField label="Speaker" htmlFor="node-output" {...gone("output", outputs, "speaker")}>{select("output", outputs, "Speaker")}</DField>
    </section>
  )
}
