import { ActionError, CurrentTurn, defineAction, defineCollection, defineModule, makeTool, Param, Setting, ToolError } from "@pva/core"
import { BriefingSections, defineTexts, homeLanguage, isLine, type Language, say, StoredText } from "@pva/module-contracts"
import { Clock, Effect, Schema } from "effect"
import { compose, join, type Kind, matchesId } from "./compose.ts"
import { texts } from "./texts.ts"

export { compose, join, MAX_SECTIONS, SENTENCES } from "./compose.ts"
export { texts } from "./texts.ts"

/** The most sections a person can leave out of their own briefing. */
export const MAX_SKIPPED = 10

const SECTION_ID = /^[a-z0-9][a-z0-9.-]{0,59}$/
const SectionId = StoredText(60).check(Schema.isPattern(SECTION_ID))
const Length = Schema.Literals(["short", "normal", "long"])

/**
 * One person's briefing preferences: the length they like and the sections they leave out. No personal content (names
 * of sections, not what they hold), but it is the person's own, so it is stored in the person's scope: with no person
 * asking there is nothing to read or write.
 */
export const Preferences = Schema.Struct({
  length: Schema.optionalKey(Length),
  skip: Schema.Array(SectionId).check(Schema.isMaxLength(MAX_SKIPPED))
})
export type Preferences = typeof Preferences.Type

export const preferences = defineCollection({
  name: "preferences",
  scope: "person",
  schema: Preferences,
  // Worst case: ten 60-character ids (2 characters of JSON per character) and a length: checkModule computes it.
  maxChars: 1_500
})

const settings = {
  length: Setting.choice({
    label: "Briefing length",
    description: "Short is only the most important things, one sentence. Long adds detail. A person's own choice (\"keep it short\") wins.",
    default: "normal",
    options: [{ value: "short", label: "Short" }, { value: "normal", label: "Normal" }, { value: "long", label: "Long" }],
    overridable: true
  }),
  order: Setting.textList({
    label: "Order of sections",
    description: "Section ids in the order they are spoken, for example weather, calendar, news. Sections not listed follow. Important items (rain from three) still come first.",
    maxItems: 20,
    itemMaxLength: 60,
    placeholder: "weather"
  }),
  skip: Setting.textList({
    label: "Sections to leave out",
    description: "Section ids never included in a briefing for anyone, for example news. A module's name leaves out all its sections.",
    maxItems: 20,
    itemMaxLength: 60,
    placeholder: "news"
  })
}

const lowerIds = (ids: ReadonlyArray<string> | undefined): ReadonlyArray<string> => (ids ?? []).map((i) => i.trim().toLowerCase()).filter((i) => SECTION_ID.test(i))

const prefId = (person: string) => `prefs-${person}`

const kindOf = (kind: Kind | undefined): Kind => kind ?? "on-request"

export const briefingModule = defineModule({
  apiVersion: 2,
  id: "briefing",
  name: "Briefing",
  description: "A short spoken briefing from the modules the assistant has on.",
  enabledByDefault: false,
  settings,
  storage: { collections: [preferences] },
  start: (ctx) =>
    Effect.gen(function*() {
      const store = ctx.store.collection(preferences)

      /** The person's own preferences, now; nothing when no person is asking, none are saved, or the store cannot say. */
      const readPrefs = (person: string | undefined) =>
        person === undefined ? Effect.succeed(undefined) : store.get(prefId(person)).pipe(Effect.map((row) => row), Effect.catch(() => Effect.succeed(undefined)))

      /** Gather and compose: the one path every tool and action takes. */
      const brief = (input: { readonly kind: Kind; readonly length: "short" | "normal" | "long" | undefined; readonly only: ReadonlyArray<string> }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const language = homeLanguage(ctx.host.view())
          const row = yield* readPrefs(turn?.person?.id)
          const length = input.length ?? row?.value.length ?? ctx.settings.length
          const sections = yield* ctx.host.contributions(BriefingSections)
          const briefing = yield* compose({
            kind: input.kind,
            length,
            skip: [...lowerIds(ctx.settings.skip), ...(row?.value.skip ?? [])],
            only: lowerIds(input.only),
            order: lowerIds(ctx.settings.order),
            language,
            turn,
            sections
          })
          return { briefing, language }
        })

      const briefingTool = makeTool({
        name: "briefing",
        description:
          "Gather a short briefing from the modules that are on (weather, calendar, bins, news and so on) for 'good morning', 'brief me' or 'what's my day like'. Returns sections of ready sentences: word them as one short spoken briefing, keep every fact, add none, and name anything listed in couldntGet once.",
        parameters: Schema.Struct({
          kind: Schema.optionalKey(Schema.Literals(["morning", "evening", "on-request"]).annotate({ description: "morning for a good-morning greeting, evening for good evening, else on-request" })),
          length: Schema.optionalKey(Length.annotate({ description: "short is the most important things only; default is the person's choice" })),
          only: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(60))).check(Schema.isMaxLength(10)).annotate({ description: "Only these sections, by id such as weather or news" }))
        }),
        risk: "read",
        latency: "quick",
        sensitivity: (result) => {
          const owner = (result as { readonly owner?: string }).owner
          return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
        },
        execute: ({ kind, length, only }) =>
          Effect.gen(function*() {
            const { briefing, language } = yield* brief({ kind: kindOf(kind), length, only: only ?? [] })
            if (briefing.noSources) return { spoken: say(texts, language, "noSources") }
            if (briefing.sections.length === 0 && briefing.failed.length === 0 && briefing.withheld === 0) return { spoken: say(texts, language, "nothing") }
            return {
              kind: briefing.kind,
              length: briefing.length,
              sections: briefing.sections.map((s) => ({ id: s.id, title: s.title, sentences: s.sentences })),
              ...(briefing.failed.length > 0 ? { couldntGet: briefing.failed } : {}),
              ...(briefing.withheld > 0 ? { withheld: say(texts, language, "withheld") } : {}),
              ...(briefing.owner !== undefined ? { owner: briefing.owner } : {})
            }
          })
      })

      const prefsTool = makeTool({
        name: "briefing_prefs",
        description:
          "Remember how this person likes their briefing: its length (\"always keep it short\"), or a section to leave out (\"skip the news\") or bring back. Needs to know who is asking.",
        parameters: Schema.Struct({
          length: Schema.optionalKey(Length.annotate({ description: "short, normal or long" })),
          skip: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(60))).check(Schema.isMaxLength(5)).annotate({ description: "Sections to leave out, by name such as news" })),
          unskip: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(60))).check(Schema.isMaxLength(5)).annotate({ description: "Sections to bring back" }))
        }),
        risk: "change",
        execute: ({ length, skip, unskip }) =>
          Effect.gen(function*() {
            const turn = yield* CurrentTurn
            const language = homeLanguage(ctx.host.view())
            const person = turn?.person?.id
            // Preferences are a person's own: nobody known is asking, so ask whose and write nothing.
            if (person === undefined) return { spoken: say(texts, language, "whose") }
            if (length === undefined && (skip ?? []).length === 0 && (unskip ?? []).length === 0) return { spoken: say(texts, language, "prefNone") }
            const clean = (names: ReadonlyArray<string>) => names.map((n) => n.trim().toLowerCase())
            const skipIds = clean(skip ?? [])
            const unskipIds = clean(unskip ?? [])
            if ([...skipIds, ...unskipIds].some((id) => !SECTION_ID.test(id))) return { spoken: say(texts, language, "prefBadSection") }
            const unsaved = () => new ToolError({ message: say(texts, language, "prefUnsaved") })
            const row = yield* store.get(prefId(person)).pipe(Effect.mapError(unsaved))
            const had = row?.value.skip ?? []
            const next = [...had.filter((id) => !unskipIds.includes(id)), ...skipIds.filter((id) => !had.includes(id))]
            const skipped = [...new Set(next)]
            if (skipped.length > MAX_SKIPPED) return { spoken: say(texts, language, "prefFull", { count: MAX_SKIPPED }) }
            const value: Preferences = { ...(length !== undefined ? { length } : row?.value.length !== undefined ? { length: row.value.length } : {}), skip: skipped }
            yield* (row === undefined ? store.insert(value, { id: prefId(person) }) : store.update(prefId(person), () => value, { expectRev: row.rev })).pipe(Effect.mapError(unsaved))
            const parts: Array<string> = []
            if (length !== undefined) parts.push(say(texts, language, "prefLength", { length: say(texts, language, length) }))
            if (skipIds.length > 0) parts.push(say(texts, language, "prefSkip", { sections: skipIds.join(", ") }))
            if (unskipIds.length > 0) parts.push(say(texts, language, "prefUnskip", { sections: unskipIds.join(", ") }))
            return { spoken: parts.join(" ") }
          })
      })

      const brieflyAction = defineAction({
        id: "brief",
        label: "Brief me",
        description: "Speak a short briefing joined from the modules that are on: weather, calendar, bins, news. Not for one subject alone (ask the weather or the news directly).",
        examples: [
          "good morning",
          "brief me",
          "give me my briefing",
          "give me the short briefing",
          "what's my day like",
          "good evening",
          "goedemorgen",
          "geef me de briefing",
          "geef me de korte briefing",
          "goedenavond"
        ],
        params: {
          length: Param.choice({ label: "Length", options: [{ value: "short", label: "short", aliases: ["kort"] }, { value: "normal", label: "normal" }, { value: "long", label: "long", aliases: ["uitgebreid"] }], optional: true }),
          kind: Param.choice({ label: "Kind", options: [{ value: "morning", label: "morning", aliases: ["goedemorgen"] }, { value: "evening", label: "evening", aliases: ["goedenavond"] }, { value: "on-request", label: "any time" }], optional: true })
        },
        risk: "read",
        run: ({ length, kind }) =>
          brief({ kind: kindOf(kind), length, only: [] }).pipe(
            Effect.map(({ briefing, language }) => ({ say: join(briefing, language) })),
            Effect.catchCause((cause) => (cause.reasons.some((r) => r._tag === "Interrupt") ? Effect.failCause(cause) : Effect.fail(new ActionError({ message: say(texts, homeLanguage(ctx.host.view()), "nothing") }))))
          )
      })

      return {
        tools: [briefingTool, prefsTool],
        actions: [brieflyAction],
        instructions: "For 'good morning', 'brief me' or 'what's my day like', call the briefing tool and word its sections as one short spoken briefing."
      }
    })
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<import("@pva/core").ModuleDefinition<any>> = [briefingModule]
