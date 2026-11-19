import type { Effect } from "effect"
import { ServiceKey } from "./ModuleApi.ts"

/**
 * Session and device control (docs/MODULES-PLAN.md §4 P7, first version; docs/PHRASES.md). The core's services, provided
 * by serve mode through `host.service` (`ModuleHostOptions.coreServices`, like `People`); the host's essential controls
 * use the same operations, so a module's tool (the assistant-controls module, wave B) and the spoken control do one
 * thing. Every call names the device it acts on (a tool passes its turn's `deviceId`); a device with no voice session
 * (nobody has started audio there) has nothing to stop, cancel or repeat. Absent in the CLI modes.
 */
export interface SessionControlService {
  /**
   * Stop the reply being prepared or spoken on the device (every assistant's conversation there, as the page's Stop
   * does) and the announcement being spoken there. Whether anything was stopped.
   */
  readonly stopReply: (deviceId: string) => Effect.Effect<boolean>
  /**
   * Cancel a pending interaction on the device: a reply being prepared or spoken (as `stopReply`, announcements left
   * alone) and an open armed or follow-up window, so the next sentence needs the wake phrase again. Whether anything was
   * pending. Says nothing.
   */
  readonly cancelPending: (deviceId: string) => Effect.Effect<boolean>
  /**
   * Speak the device's last spoken reply again, with the voice of the assistant that said it, as a canned reply (no
   * model, nothing added to the history). `false`: nothing has been said there yet (since its session started).
   */
  readonly repeatLast: (deviceId: string) => Effect.Effect<boolean>
  /** A new conversation with the device's answering assistant (as `conversation.new`). Its id; `undefined`: no such device. */
  readonly newConversation: (deviceId: string) => Effect.Effect<string | undefined>
}

export const SessionControl = ServiceKey<SessionControlService>("core.session-control")

/** One change of a device's reply volume: the level now (`REPLY_VOLUME` in `@pva/protocol`) and whether it was at the bound already. */
export interface VolumeChange {
  readonly level: number
  readonly atLimit: boolean
}

/**
 * The device's reply volume: one level per device, kept in memory by the server (reset at a restart), sent to its voice
 * pages as `output.volume` (a gain node on the page's reply output). Steps and bounds: `REPLY_VOLUME` (0.2 to 1 in
 * steps of 0.2, default 1, today's level).
 */
export interface DeviceControlService {
  /** The level now (the default for a device nobody changed). */
  readonly replyVolume: (deviceId: string) => number
  /** One step louder or quieter, or a level (moved to the nearest step within the bounds); every page of the device is told. */
  readonly changeReplyVolume: (deviceId: string, change: "louder" | "quieter" | { readonly to: number }) => Effect.Effect<VolumeChange>
}

export const DeviceControl = ServiceKey<DeviceControlService>("core.device-control")
