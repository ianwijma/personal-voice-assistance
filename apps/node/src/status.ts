/**
 * `node.status` (docs/VOICE-NODES.md §5.3, §8): what the node tells admin about its audio. Sent after every
 * `welcome`, then whenever the status changes (the device lists are polled; an open failure or a missing tool shows
 * up at once), at most once per `throttleMs`. Nothing is sent while there is no connection; the next `welcome` sends
 * the current status again.
 */
import type { AudioDeviceInfo, ClientMessage, NodeStatusBody } from "@pva/protocol"
import { MIC_SAMPLE_RATE } from "@pva/protocol"
import type { AudioDevices } from "./audio.ts"

export type StatusMessage = Extract<ClientMessage, { readonly type: "node.status" }>

export interface StatusOptions {
  /** `node.status.backend`: the device backend, or `file` when both sides are WAV files. */
  readonly backend: "pipewire" | "alsa" | "file"
  /** The devices now; `undefined` (or a failure) lists none. */
  readonly list: () => Promise<AudioDevices | undefined>
  /** Programs the backend needs that are missing. */
  readonly missingTools: () => ReadonlyArray<string>
  /** The device ids in use (`""` = the backend's default); `undefined` = that side is not a device. */
  readonly opened: () => { readonly input: string | undefined; readonly output: string | undefined }
  readonly throttleMs: number
  readonly pollMs: number
  readonly now?: () => number
}

export interface StatusReporter {
  /** A connection reached `welcome`: send the status now. */
  readonly connected: (send: (message: StatusMessage) => void) => void
  readonly disconnected: () => void
  /** Something may have changed (a device failed to open, a setting was applied): look again soon. */
  readonly changed: () => void
  /** Record the last problem (shown in admin) and send it. */
  readonly setError: (message: string) => void
  /** Forget the last problem, when it is still this one (or any, without an argument). */
  readonly clearError: (message?: string) => void
  readonly stop: () => void
}

const cap = <T>(items: ReadonlyArray<T>, max: number): Array<T> => items.slice(0, max)

const defaultId = (devices: ReadonlyArray<AudioDeviceInfo>): string => devices.find((d) => d.isDefault)?.id ?? "default"

export const makeStatusReporter = (options: StatusOptions): StatusReporter => {
  const now = options.now ?? Date.now
  let link: ((message: StatusMessage) => void) | undefined
  let lastError: { message: string; at: number } | undefined
  let lastKey: string | undefined
  let lastSentAt = -Infinity
  let pending: StatusMessage | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let generation = 0

  const build = async (): Promise<StatusMessage> => {
    const devices = await options.list().catch(() => undefined)
    const inputs = cap(devices?.inputs ?? [], 64)
    const outputs = cap(devices?.outputs ?? [], 64)
    const used = options.opened()
    const missing = options.missingTools()
    const body: NodeStatusBody = {
      backend: options.backend,
      inputs,
      outputs,
      ...(used.input !== undefined ? { input: { opened: used.input === "" ? defaultId(inputs) : used.input, sampleRate: MIC_SAMPLE_RATE } } : {}),
      ...(used.output !== undefined ? { output: { opened: used.output === "" ? defaultId(outputs) : used.output } } : {}),
      ...(missing.length > 0 ? { missingTools: cap(missing, 8) } : {}),
      ...(lastError !== undefined ? { lastError: { message: lastError.message.slice(0, 500), at: lastError.at } } : {})
    }
    return { type: "node.status", ...body }
  }

  const emit = (message: StatusMessage) => {
    if (link === undefined) return
    lastKey = JSON.stringify(message)
    lastSentAt = now()
    pending = undefined
    link(message)
  }

  const deliver = (message: StatusMessage, force: boolean) => {
    if (link === undefined || stopped) return
    if (!force && JSON.stringify(message) === lastKey) return
    const wait = lastSentAt + options.throttleMs - now()
    if (wait <= 0) return emit(message)
    pending = message
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined
        if (pending !== undefined) emit(pending)
      }, wait)
    }
  }

  const refresh = (force: boolean) => {
    const mine = generation
    void build().then((message) => {
      if (mine === generation) deliver(message, force)
    })
  }

  const poll = setInterval(() => refresh(false), options.pollMs)
  poll.unref()

  return {
    connected: (send) => {
      generation++
      link = send
      lastKey = undefined
      lastSentAt = -Infinity
      pending = undefined
      refresh(true)
    },
    disconnected: () => {
      generation++
      link = undefined
      pending = undefined
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
    changed: () => refresh(false),
    setError: (message) => {
      lastError = { message, at: now() }
      refresh(false)
    },
    clearError: (message) => {
      if (message === undefined || lastError?.message === message) lastError = undefined
    },
    stop: () => {
      stopped = true
      clearInterval(poll)
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
  }
}
