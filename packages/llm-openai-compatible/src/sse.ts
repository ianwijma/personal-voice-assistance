/**
 * A minimal incremental server-sent-events parser for chat-completion streams.
 *
 * Fed raw text as it arrives (any split, `\n` or `\r\n` line ends), it yields
 * one `SseEvent` per blank-line-terminated event. Comment lines (starting with
 * `:`, e.g. OpenRouter's `: OPENROUTER PROCESSING` keep-alives) produce no event
 * but are counted, so a caller can tell a live connection from a dead one.
 * Multi-line `data:` fields are joined with `\n`, as the SSE spec says.
 */

export interface SseEvent {
  /** The `event:` field; `undefined` when absent (the usual case for chat completions). */
  readonly event: string | undefined
  readonly data: string
}

export class SseParser {
  private buffer = ""
  private data: Array<string> = []
  private event: string | undefined = undefined
  /** Comment lines seen so far. */
  comments = 0

  /** Parse a chunk of text; returns the events it completed. */
  push(text: string): Array<SseEvent> {
    this.buffer += text
    const events: Array<SseEvent> = []
    let newline: number
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      this.line(line, events)
    }
    return events
  }

  /** The stream ended: dispatch a final event that was not followed by a blank line. */
  end(): Array<SseEvent> {
    const events: Array<SseEvent> = []
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer
      this.buffer = ""
      this.line(line, events)
    }
    this.dispatch(events)
    return events
  }

  private line(line: string, events: Array<SseEvent>): void {
    if (line === "") {
      this.dispatch(events)
      return
    }
    if (line.startsWith(":")) {
      this.comments++
      return
    }
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") this.data.push(value)
    else if (field === "event") this.event = value
    // `id` and `retry` are irrelevant for a single request.
  }

  private dispatch(events: Array<SseEvent>): void {
    if (this.data.length > 0) events.push({ event: this.event, data: this.data.join("\n") })
    this.data = []
    this.event = undefined
  }
}
