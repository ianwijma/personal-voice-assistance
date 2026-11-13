import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { AudioError } from "@pva/core"
import { Deferred, Effect, type Scope } from "effect"

/** A program and its arguments. Injectable so tests can use stand-in processes. */
export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export interface ProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface RunningProcess {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>
  /** Completes when the process has exited (or failed to spawn). */
  readonly exited: Deferred.Deferred<ProcessExit, AudioError>
  /** The tail of what the process wrote to stderr. */
  readonly stderr: () => string
}

const stderrLimit = 4096

/** "pw-cat exited with code 1: <stderr>" */
export const describeExit = (command: Command, exit: ProcessExit, stderr: string): string => {
  const how = exit.signal !== null ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`
  const tail = stderr.trim()
  return `${command.command} ${how}${tail === "" ? "" : `: ${tail}`}`
}

/**
 * Spawn a process for the lifetime of the current scope. Closing the scope
 * SIGKILLs it (if it is still running) and waits for it to be gone, so audio it
 * was playing has stopped when the finalizer returns. SIGKILL rather than
 * SIGTERM: we want silence now, not a graceful drain.
 */
export const spawnScoped = (command: Command): Effect.Effect<RunningProcess, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync((): RunningProcess => {
      const exited = Deferred.makeUnsafe<ProcessExit, AudioError>()
      let stderr = ""
      const child = spawn(command.command, [...command.args], { stdio: ["pipe", "pipe", "pipe"] })
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString("utf8")).slice(-stderrLimit)
      })
      // Writes to a dead process raise EPIPE on stdin; the exit handler reports it.
      child.stdin.on("error", () => {})
      child.on("error", (cause) => {
        Deferred.doneUnsafe(
          exited,
          Effect.fail(new AudioError({ message: `failed to start ${command.command}: ${cause.message}`, cause }))
        )
      })
      child.on("exit", (code, signal) => {
        Deferred.doneUnsafe(exited, Effect.succeed({ code, signal }))
      })
      return { child, exited, stderr: () => stderr }
    }),
    ({ child, exited }) =>
      Effect.gen(function*() {
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
          child.kill("SIGKILL")
        }
        yield* Effect.ignore(Deferred.await(exited))
      })
  )
