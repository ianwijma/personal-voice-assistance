// Calls offThread itself, from inside a worker: it must be refused (tasks do not nest). Answers the reason, or "ran".
import { offThread, offThreadTask } from "@pva/core"
import { Effect, Exit } from "effect"

const plain = offThreadTask<(input: string) => string>(new URL("./plain.task.mjs", import.meta.url))

export default async (_input: string): Promise<string> => {
  const exit = await Effect.runPromiseExit(offThread(plain, "x", { timeoutMs: 5_000 }))
  if (Exit.isSuccess(exit)) return "ran"
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason !== undefined && reason._tag === "Fail" ? reason.error.reason : "defect"
}
