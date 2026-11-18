// What a consumer of a contract relies on that is code, not documentation: `useService` and `ProviderOff`, the keys'
// ids, and the two authoring helpers. A consumer's tests give it a stub of the contract (`stubService` in
// `@pva/core/testing`), programmed with what the contract's documentation allows; the consumer below is the example
// docs/MODULES.md quotes.
import { assert, describe, it } from "@effect/vitest"
import { defineModule, makeTool, type ModuleHostApi } from "@pva/core"
import { fails, provide, startTestModule, STORED_TEXT_PATTERN_SOURCE, stops, stubService } from "@pva/core/testing"
import { Effect, Schema } from "effect"
import {
  BriefingSections,
  defineTexts,
  HomeAssistant,
  homeLanguage,
  isContractId,
  Lists,
  ListsError,
  type ListsService,
  Playback,
  ProviderOff,
  providerOffText,
  say,
  STORED_TEXT_PATTERN,
  StoredText,
  Timers,
  useService
} from "../src/index.ts"

describe("a consumer of a service", () => {
  // #region consumer
  /** The consumer's own sentences, in both languages; a contract's errors carry a reason, which it words itself. */
  const consumerTexts = defineTexts({
    en: { added: "Rice is on the shopping list.", full: "The shopping list is full.", failed: "I couldn't reach the shopping list." },
    nl: { added: "Rijst staat op het boodschappenlijstje.", full: "Het boodschappenlijstje is vol.", failed: "Ik kon het boodschappenlijstje niet bereiken." }
  })

  /** A consumer: asks the lists module through useService, and says so in the household's language when it is off. */
  const consumer = defineModule({
    apiVersion: 2,
    id: "consumer",
    name: "Consumer",
    description: "Adds rice.",
    enabledByDefault: false,
    start: (ctx) =>
      Effect.succeed({
        tools: [makeTool({
          name: "consumer_add",
          description: "Add rice to the shopping list.",
          parameters: Schema.Struct({}),
          risk: "change",
          execute: () => {
            const lang = homeLanguage(ctx.host.view())
            return useService(ctx.host, Lists, (lists) => lists.addItem({ text: "Rice", dedupeKey: "consumer:rice" })).pipe(
              Effect.map(() => say(consumerTexts, lang, "added")),
              Effect.catchTag("ProviderOff", () => Effect.succeed(providerOffText(lang, "Lists"))),
              Effect.catchTag("ListsError", (e) => Effect.succeed(say(consumerTexts, lang, e.reason === "limit" ? "full" : "failed")))
            )
          }
        })]
      })
  })
  // #endregion consumer

  it.effect("the provider on, off, full, and stopping mid-call", () =>
    Effect.gen(function*() {
      // #region consumer-test
      // A stub answers what the test programs, and records what it was asked; it does nothing of its own.
      const lists = stubService<ListsService>("lists", {
        addItem: (request) => Effect.succeed({ outcome: "added", item: { id: "item-1", text: request.text, status: "open", ...(request.dedupeKey !== undefined ? { dedupeKey: request.dedupeKey } : {}) } })
      })
      const on = yield* startTestModule(consumer, { provide: [provide("lists", { services: [Lists.of(lists.service)] })] })
      assert.strictEqual((yield* on.tool("consumer_add", {})).value, "Rice is on the shopping list.")
      assert.deepStrictEqual(lists.calls.addItem, [[{ text: "Rice", dedupeKey: "consumer:rice" }]])
      // The answers the contract allows: full, and the provider stopping during the call.
      lists.answer("addItem", fails(new ListsError({ reason: "limit", detail: "500 open items" })))
      assert.strictEqual((yield* on.tool("consumer_add", {})).value, "The shopping list is full.")
      lists.answer("addItem", stops())
      assert.strictEqual((yield* on.tool("consumer_add", {})).value, "The Lists module is off.")
      // No lists module at all, in a Dutch household.
      const off = yield* startTestModule(consumer, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual((yield* off.tool("consumer_add", {})).value, "De module Lists staat uit.")
      // #endregion consumer-test
    }))
})

describe("useService", () => {
  it.effect("the service missing, and a ModuleStopped defect, become ProviderOff with the key's id; typed errors pass through", () =>
    Effect.gen(function*() {
      const none: Pick<ModuleHostApi, "service"> = { service: () => undefined }
      const off = yield* Effect.flip(useService(none, Lists, (l) => l.find("consumer:rice")))
      assert.instanceOf(off, ProviderOff)
      assert.strictEqual(off.service, "lists")
      const stopping = stubService<ListsService>("lists", { find: stops() })
      const stopped = yield* Effect.flip(useService({ service: () => stopping.service as never }, Lists, (l) => l.find("consumer:rice")))
      assert.instanceOf(stopped, ProviderOff)
      const failing = stubService<ListsService>("lists", { find: fails(new ListsError({ reason: "busy", detail: "store busy" })) })
      const typed = yield* Effect.flip(useService({ service: () => failing.service as never }, Lists, (l) => l.find("consumer:rice")))
      assert.instanceOf(typed, ListsError)
    }))
})

describe("the keys and the authoring helpers", () => {
  it("keys have the ids the plan names", () => {
    assert.deepStrictEqual([Lists.id, Timers.id, HomeAssistant.id, Playback.id, BriefingSections.id], ["lists", "timers", "home-assistant", "playback", "briefing.sections"])
  })

  it("isContractId takes an explicit bound", () => {
    assert.isTrue(isContractId("a".repeat(200), 200))
    assert.isFalse(isContractId("a".repeat(201), 200))
    assert.isFalse(isContractId("a b", 10))
  })

  it("StoredText keeps text whose JSON is at most twice as long, and the kit knows its pattern", () => {
    assert.strictEqual(STORED_TEXT_PATTERN.source, STORED_TEXT_PATTERN_SOURCE)
    const ok = Schema.is(StoredText(30))
    assert.isTrue(ok("Quote \" and \\ and\nnewline"))
    assert.isFalse(ok("bell \u0007"))
    assert.isFalse(ok("lone \ud800"))
    assert.isTrue(ok("emoji 🍚"))
    assert.isFalse(ok("x".repeat(31)))
  })

  it("texts in two languages, the household's language, and the provider-off sentence in both", () => {
    const texts = defineTexts({ en: { added: "Added {item}." }, nl: { added: "{item} staat erop." } })
    assert.strictEqual(say(texts, homeLanguage({ home: { HOME_LANGUAGE: "nl-NL" } }), "added", { item: "rijst" }), "rijst staat erop.")
    assert.strictEqual(say(texts, homeLanguage({ home: { HOME_LANGUAGE: "de-DE" } }), "added", { item: "rice" }), "Added rice.")
    assert.strictEqual(providerOffText("en", "Smart home"), "The Smart home module is off.")
    assert.strictEqual(providerOffText("nl", "Smart home"), "De module Smart home staat uit.")
  })
})
