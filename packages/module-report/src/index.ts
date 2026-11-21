import { CurrentTurn, defineModule, makeTool, type ModuleDefinition, Reports, Setting } from "@pva/core"
import { homeLanguage, isLine, say, StoredText } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { texts } from "./texts.ts"

export { texts } from "./texts.ts"

/**
 * Reports (docs/modules/report.md, docs/REPORTS.md): the person's way to tell the assistant's developers about a
 * problem or a feature idea. The module is thin: one tool that passes what the person said to the core's `Reports`
 * service, which adds the conversation, the traces, the device, the assistant and the server's state, keeps the
 * report as a draft for the owner, and files it as a GitHub issue when the owner sends it (or at once, when the owner
 * chose that). The module's own settings hold the token and that choice; it hands them to the host from its shared
 * part and takes them back when that part closes.
 *
 * Risk: drafting writes a local record (`change`). With "send at once" on and a token set, a call posts a public
 * issue in the owner's name: the tool is then declared `message`, so the household's risk policy decides (by default
 * `message` is refused, and the tool is not offered until the owner allows it).
 */

const settings = {
  githubToken: Setting.secret({
    label: "GitHub token",
    description:
      "A fine-grained personal access token with Issues: read and write on ianwijma/personal-voice-assistance. Kept in the key vault. Without one, reports are kept and you file each by hand from Reports in the admin panel."
  }),
  sendImmediately: Setting.boolean({
    label: "Send at once",
    description:
      "File a new report on GitHub without waiting for you to read it. Reports then go out in your name as they are, to a public repository, nobody reading them first: what the assistant said, tool results and the previous conversation included. The tool needs the message class allowed (Shared settings › Risk policy).",
    default: false
  })
}

/** One line, at least three characters, at most `max`. */
const oneLine = (max: number) => StoredText(max).check(Schema.isMinLength(3), Schema.makeFilter((t: string) => isLine(t, max) || "one line, without line breaks"))

const Parameters = Schema.Struct({
  kind: Schema.Literals(["problem", "feature"]).annotate({ description: "problem: something the assistant did wrong or failed to do; feature: an idea for something new" }),
  title: oneLine(120).annotate({ description: "One short line naming it, in the person's language, such as \"The kitchen timer did not ring\"" }),
  description: StoredText(2_000).check(Schema.isMinLength(3)).annotate({
    description: "What the person said is wrong or wanted, in their own words as far as possible, with what they saw or heard"
  }),
  answers: Schema.optionalKey(
    Schema.Array(Schema.Struct({
      question: StoredText(300).check(Schema.isMinLength(1)).annotate({ description: "What you asked" }),
      answer: StoredText(1_000).check(Schema.isMinLength(1)).annotate({ description: "What the person answered, in their words" })
    })).check(Schema.isMaxLength(4)).annotate({ description: "The questions you asked before filing and the answers, in order" })
  )
})

export const reportModule = defineModule({
  apiVersion: 2,
  id: "report",
  name: "Reports",
  description: "Lets a person report a problem with the assistant or suggest a feature; the owner reads the report and sends it to the project on GitHub.",
  enabledByDefault: false,
  settings,
  requires: [{ network: "internet", why: "Filing reports as GitHub issues, only when a token is set" }],
  health: ({ settings: s, running }) =>
    Effect.sync(() => {
      if (s === undefined || !running) return []
      const issues: Array<{ id: string; severity: "info" | "warning"; title: string; detail: string }> = []
      if (s.githubToken === undefined) {
        issues.push({
          id: "report.no-token",
          severity: s.sendImmediately ? "warning" : "info",
          title: s.sendImmediately ? "Send at once is on, but there is no GitHub token" : "No GitHub token for reports",
          detail: "Reports are kept, and the admin panel's Reports page opens GitHub's new-issue page to file each by hand. Set a token on the module's page to send them from there."
        })
      }
      return issues
    }),
  shared: (ctx) =>
    Effect.gen(function*() {
      // The owner's choices go to the host while this part runs, and are taken back when it closes (a stop, a restart,
      // a settings change): the host never keeps a token the module no longer runs with.
      const reports = ctx.host.service(Reports)
      if (reports !== undefined) {
        const token = ctx.settings.githubToken
        yield* Effect.acquireRelease(
          reports.configure({ sendImmediately: ctx.settings.sendImmediately === true, ...(token !== undefined ? { token } : {}) }),
          () => reports.configure(undefined)
        )
      }
      return { value: undefined }
    }),
  start: (ctx) =>
    Effect.sync(() => {
      // Sending at once posts a public issue in the owner's name: that is the `message` class, decided by the policy.
      const sends = ctx.settings.sendImmediately && ctx.settings.githubToken !== undefined
      const file = makeTool({
        name: "report_file",
        description:
          `File a report about this assistant itself: a problem (something it did wrong or failed to do) or an idea for a new feature. The conversation, the device, the assistant's setup and the server's recent state are attached automatically, so give only what the person said. ${
            sends ? "It is sent at once as a public GitHub issue in the owner's name." : "It is kept as a draft for the owner to read and send."
          } Answers with a sentence to say.`,
        parameters: Parameters,
        risk: sends ? "message" : "change",
        sensitivity: "household",
        // Drafting is local work; sending at once waits for GitHub (at most 3.5 s).
        latency: sends ? "slow" : "quick",
        execute: ({ kind, title, description, answers }) =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            const turn = yield* CurrentTurn
            // Looked up at each use: absent in the CLI modes (and outside a turn there is no conversation to attach).
            const reports = ctx.host.service(Reports)
            if (reports === undefined || turn === undefined) return { spoken: say(texts, lang, "unavailable") }
            // The host reads the turn itself; `send` is what this tool was declared as (`message` only when it sends).
            const drafted = yield* reports.draft({ kind, title, description, ...(answers !== undefined ? { answers } : {}), send: sends }).pipe(Effect.exit)
            if (drafted._tag === "Failure") return { spoken: say(texts, lang, "failed") }
            const r = drafted.value
            if (r.status === "sent") return { spoken: r.issueNumber !== undefined ? say(texts, lang, "sent", { number: r.issueNumber }) : say(texts, lang, "sentNoNumber") }
            if (r.status === "failed") return { spoken: say(texts, lang, "sendFailed") }
            return { spoken: say(texts, lang, "kept") }
          })
      })
      return {
        tools: [file],
        instructions:
          "When the person reports something wrong with the assistant itself, or suggests a feature for it, use report_file. Before you call it, if the report lacks what a developer needs, ask at most two short questions, one per turn: for a problem, what they expected and what they saw or heard instead (the screen is not captured, so ask what was on it when that matters); for a feature, what it should do and when they would use it. Never invent details, keep the person's own words in description, and do not repeat the conversation: it is attached automatically."
      }
    })
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once): the production definition of
 * every module id the package has.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [reportModule]
