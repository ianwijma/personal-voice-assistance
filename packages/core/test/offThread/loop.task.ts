// Never returns: only termination ends it. When `entered` names a file, it writes it first, so a test knows the task
// has begun its loop (not merely that a worker was started).
import { writeFileSync } from "node:fs"

export default (input: { readonly entered: string }): never => {
  if (input.entered !== "") writeFileSync(input.entered, "")
  for (;;) {
    // spin
  }
}
