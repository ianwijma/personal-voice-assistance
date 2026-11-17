import { Stream } from "effect"

export interface ClauseChunkerOptions {
  /** Minimum clause length before a `,` ends the first clause. Default 12. */
  readonly firstMinLength?: number
  /** Minimum clause length before a `,` ends later clauses. Default 40. */
  readonly minLength?: number
}

interface State {
  /** Text not yet emitted. */
  buffer: string
  /** Index in `buffer` from which to resume scanning. */
  scanFrom: number
  emitted: number
}

const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\t" || c === "\r"

/**
 * Buffers text deltas and emits trimmed clauses at sentence or clause
 * boundaries: `. ! ? ; :` followed by whitespace, a newline, and — once the
 * clause is long enough — `,` followed by whitespace. The first clause uses a
 * shorter minimum so speech starts as early as possible. Whatever is left is
 * emitted when the input ends.
 *
 * A boundary needs the following whitespace so "3.5" or "e.g." mid-word is not
 * split; a delta ending in punctuation therefore waits for the next delta (or
 * the end of the stream). Emit "\n" to force a flush.
 */
export const chunkClauses = (options: ClauseChunkerOptions = {}) => {
  const firstMin = options.firstMinLength ?? 12
  const min = options.minLength ?? 40

  const step = (state: State, delta: string): readonly [State, ReadonlyArray<string>] => {
    let buffer = state.buffer + delta
    let i = state.scanFrom
    let start = 0
    let emitted = state.emitted
    const out: Array<string> = []
    for (; i < buffer.length; i++) {
      const c = buffer[i]
      let cut = -1
      if (c === "\n") {
        cut = i
      } else if (c === "." || c === "!" || c === "?" || c === ";" || c === ":") {
        if (i + 1 < buffer.length && isSpace(buffer[i + 1])) cut = i + 1
        else if (i + 1 >= buffer.length) break // need the next character to decide
      } else if (c === ",") {
        if (i + 1 >= buffer.length) break
        if (isSpace(buffer[i + 1])) {
          const length = i + 1 - start
          if (length >= (emitted === 0 ? firstMin : min)) cut = i + 1
        }
      }
      if (cut >= 0) {
        const clause = buffer.slice(start, cut).trim()
        if (clause.length > 0) {
          out.push(clause)
          emitted++
        }
        start = cut
      }
    }
    buffer = buffer.slice(start)
    return [{ buffer, scanFrom: i - start, emitted }, out]
  }

  return <E, R>(self: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
    Stream.mapAccum(self, (): State => ({ buffer: "", scanFrom: 0, emitted: 0 }), step, {
      onHalt: (state) => {
        const rest = state.buffer.trim()
        return rest.length > 0 ? [rest] : []
      }
    })
}
