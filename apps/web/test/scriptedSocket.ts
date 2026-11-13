/**
 * A WebSocket the tests drive: the client's connection opens it, the test delivers server messages.
 * Install with `installScriptedSocket()` (restored after each test).
 */
import { encodeServerMessage } from "@pva/protocol"
import { afterEach, beforeEach } from "vitest"

export class ScriptedSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: ScriptedSocket | undefined
  readyState = 0
  binaryType = "blob"
  onopen: (() => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    ScriptedSocket.last = this
  }
  send() {}
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  text(message: Parameters<typeof encodeServerMessage>[0]) {
    this.onmessage?.({ data: encodeServerMessage(message) })
  }
  binary(frame: Uint8Array<ArrayBuffer>) {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) })
  }
}


export const installScriptedSocket = () => {
  const real = globalThis.WebSocket
  beforeEach(() => {
    ScriptedSocket.last = undefined
    ;(globalThis as { WebSocket: unknown }).WebSocket = ScriptedSocket
  })
  afterEach(() => {
    ;(globalThis as { WebSocket: unknown }).WebSocket = real
  })
}
