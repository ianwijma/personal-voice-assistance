import { Conversation, stripVoiceMarkersStream } from "@pva/core"
import { Effect, Stream } from "effect"

/**
 * Text mode over any stream of input lines: each non-empty line is one turn;
 * reply deltas go to `write` as they arrive (voice markers removed, so the user
 * never sees them), followed by a newline. LLM errors are logged and the loop
 * goes on.
 */
export const runTextTurns = <E>(
  lines: Stream.Stream<string, E>,
  write: (text: string) => void,
  afterTurn: () => void = () => {}
): Effect.Effect<void, E, Conversation> =>
  Effect.gen(function*() {
    const conversation = yield* Conversation
    yield* lines.pipe(
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.runForEach((line) => {
        let midLine = false
        return conversation.textTurn(line).pipe(
          stripVoiceMarkersStream,
          Stream.runForEach((delta) =>
            Effect.sync(() => {
              write(delta)
              midLine = !delta.endsWith("\n")
            })
          ),
          Effect.andThen(Effect.sync(() => {
            if (midLine) write("\n")
          })),
          Effect.catch((error) => Effect.logError(`LLM error: ${error.message}`)),
          Effect.andThen(Effect.sync(afterTurn))
        )
      })
    )
  })
