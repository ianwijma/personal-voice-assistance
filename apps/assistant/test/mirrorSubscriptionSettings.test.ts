// `mirrorSubscriptionSettings` (WP-13a): a save of the Claude subscription agent's module settings is mirrored into the
// migrated assistant. The store-level flow is covered in migrateAssistants.test.ts; these are the edges of the function.
import type { Assistant } from "@pva/protocol"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { moduleCatalog } from "../src/modules.ts"
import { mirrorSubscriptionSettings } from "../src/serve/migrateAssistants.ts"
import { openStore } from "./support/store.ts"

const context = { env: {}, catalog: moduleCatalog }
let onSubscription: Assistant

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pva-mirror-"))
  const store = await Effect.runPromise(openStore(dir, { assistants: { env: { LLM_PROVIDER: "claude-subscription" }, catalog: moduleCatalog } }))
  onSubscription = store.assistants()[0]!
})

describe("mirrorSubscriptionSettings", () => {
  it("returns the very same assistant when the save changed none of the mirrored settings", () => {
    const before = { optIn: true, model: "claude-haiku-5-5" }
    expect(mirrorSubscriptionSettings(onSubscription, before, { ...before, claudePath: "/opt/claude" }, context)).toBe(onSubscription)
  })

  it("does not replace the assistant's prompt with an emptied system prompt", () => {
    const withPrompt = { ...onSubscription, prompt: "Assistant prompt." }
    const out = mirrorSubscriptionSettings(withPrompt, { systemPrompt: "Old." }, { systemPrompt: "   " }, context)
    expect(out.prompt).toBe("Assistant prompt.")
  })

  it("without a module catalog, keeps the model and the prompt within the assistant's limits", () => {
    const out = mirrorSubscriptionSettings(onSubscription, {}, { model: "m".repeat(300), systemPrompt: "p".repeat(5000) }, { env: {} })
    expect(out.llm.model).toHaveLength(100)
    expect(out.prompt).toHaveLength(4000)
  })

  it("mirrors a changed model, but only that: the other fields keep their values", () => {
    const out = mirrorSubscriptionSettings(onSubscription, {}, { model: "claude-sonnet-5-5" }, context)
    expect(out.llm).toEqual({ ...onSubscription.llm, model: "claude-sonnet-5-5" })
    expect(out.prompt).toBe(onSubscription.prompt)
    expect(out.replyEarly).toBe(onSubscription.replyEarly)
  })

  it("mirrors the idle minutes as the module's form reads them: a value its form rejects (under 5) is not mirrored", () => {
    expect(mirrorSubscriptionSettings(onSubscription, {}, { sessionIdleMinutes: 30 }, context).llm.freshSessionAfterMinutes).toBe(30)
    expect(mirrorSubscriptionSettings(onSubscription, {}, { sessionIdleMinutes: 1 }, context)).toBe(onSubscription)
  })

  it("without a module catalog, clamps the idle minutes to 0..1440", () => {
    const bare = { env: {} }
    expect(mirrorSubscriptionSettings(onSubscription, {}, { sessionIdleMinutes: 0 }, bare).llm.freshSessionAfterMinutes).toBe(0)
    expect(mirrorSubscriptionSettings(onSubscription, {}, { sessionIdleMinutes: 99999 }, bare).llm.freshSessionAfterMinutes).toBe(1440)
  })

  it("leaves an assistant on another account untouched", () => {
    const other = { ...onSubscription, llm: { ...onSubscription.llm, account: "anthropic" } } as Assistant
    expect(mirrorSubscriptionSettings(other, {}, { model: "claude-sonnet-5-5", tools: false }, context)).toBe(other)
  })
})
