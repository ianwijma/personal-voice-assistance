// badAnswer.task.ts: the real reading task, whose answer has its last line cut when the file says `X-BROKEN` (tests:
// an answer the main thread cannot read whole).
import type { TaskInput } from "../src/answer.ts"
import read from "../src/ics.task.ts"

export default (input: TaskInput): string => {
  const answer = read(input)
  if (!input.text.includes("X-BROKEN")) return answer
  const lines = answer.split("\n")
  lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, -5)
  return lines.join("\n")
}
