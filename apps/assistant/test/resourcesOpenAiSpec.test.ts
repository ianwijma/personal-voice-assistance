// The pool's identity of the OpenRouter and home-model accounts (WP-13b): what `llmSpecOf` keeps, what is in the key
// shown in the status, and the settings `llmConfigOf` hands the account's adapter. Pure functions, no network.
import type { AssistantLlm } from "@pva/protocol"
import { describe, expect, it } from "vitest"
import { llmConfigOf, llmIdentityOf, llmKeyOf, llmLabelOf, llmSpecOf } from "../src/serve/Resources.ts"

const assistantLlm = (account: AssistantLlm["account"], model: string, over: Partial<AssistantLlm> = {}): AssistantLlm => ({
  account,
  model,
  effort: "low",
  thinking: "off",
  maxTokens: 300,
  giveUpMs: 4000,
  warmUp: true,
  useModules: true,
  freshSessionAfterMinutes: 0,
  ...over
})

describe("llmSpecOf: OpenRouter and home model", () => {
  it("keeps the assistant's model, longest reply, give-up time and warm-up (the anthropic defaults do not apply)", () => {
    const spec = llmSpecOf(assistantLlm("openrouter", "vendor/model"))
    expect(spec).toMatchObject({ account: "openrouter", model: "vendor/model", maxTokens: 300, giveUpMs: 4000, warmUp: true })
  })

  it("OpenRouter shows its default address when none is set; a home model shows none", () => {
    expect(llmSpecOf(assistantLlm("openrouter", "m")).address).toBe("https://openrouter.ai/api/v1")
    expect(llmSpecOf(assistantLlm("openrouter", "m"), { openrouter: { address: "" } }).address).toBe("https://openrouter.ai/api/v1")
    expect(llmSpecOf(assistantLlm("home-model", "m")).address).toBeUndefined()
    expect(llmSpecOf(assistantLlm("home-model", "m"), { "home-model": { address: "" } }).address).toBeUndefined()
  })

  it("takes the account's own shared settings, not another account's", () => {
    const accounts = { anthropic: { address: "https://a.example", credential: "ka" }, "home-model": { address: "http://h:1", credential: "kh" } }
    expect(llmSpecOf(assistantLlm("home-model", "m"), accounts)).toMatchObject({ address: "http://h:1", credential: "kh" })
    expect(llmSpecOf(assistantLlm("openrouter", "m"), accounts)).toMatchObject({ address: "https://openrouter.ai/api/v1" })
    expect(llmSpecOf(assistantLlm("openrouter", "m"), accounts).credential).toBeUndefined()
  })
})

describe("llmKeyOf: OpenRouter and home model", () => {
  const home = (over: Partial<AssistantLlm> = {}, address = "http://h:1") =>
    llmSpecOf(assistantLlm("home-model", "qwen3", over), { "home-model": { address } })

  it("equal settings share a key; effort, thinking and the other fields the adapter does not read do not count", () => {
    expect(llmKeyOf(home({ effort: "high", thinking: "adaptive", useModules: false }))).toBe(llmKeyOf(home()))
  })

  it("a change of model, longest reply, give-up time, warm-up or address makes another key", () => {
    const base = llmKeyOf(home())
    for (const over of [{ model: "other" }, { maxTokens: 301 }, { giveUpMs: 4001 }, { warmUp: false }]) {
      expect(llmKeyOf(home(over))).not.toBe(base)
    }
    expect(llmKeyOf(home({}, "http://h:2"))).not.toBe(base)
  })

  it("the account is part of the key, so the same model on the two accounts is two instances", () => {
    const or = llmKeyOf(llmSpecOf(assistantLlm("openrouter", "m")))
    const hm = llmKeyOf(llmSpecOf(assistantLlm("home-model", "m")))
    expect(or).not.toBe(hm)
    expect(or.startsWith("openrouter|m|")).toBe(true)
  })

  it("never carries a credential or the user info and query of an address", () => {
    const key = llmKeyOf(llmSpecOf(assistantLlm("home-model", "m"), { "home-model": { address: "http://user:pw-secret@h:1/v1?token=tok-secret", credential: "stamp-secret" } }))
    for (const secret of ["pw-secret", "tok-secret", "stamp-secret", "user"]) expect(key).not.toContain(secret)
    expect(key).toContain("http://h:1/v1")
  })

  it("a home model without an address has a stable key that says so; an unparsable address does not throw", () => {
    expect(llmKeyOf(llmSpecOf(assistantLlm("home-model", "m")))).toBe("home-model|m|300tok|4000ms|warm|(no address)")
    expect(llmKeyOf(llmSpecOf(assistantLlm("home-model", "m"), { "home-model": { address: "not a url" } }))).toContain("(invalid address)")
  })

  it("a new key stamp changes the instance's identity but not the key shown", () => {
    const one = llmSpecOf(assistantLlm("openrouter", "m"), { openrouter: { credential: "one" } })
    const two = llmSpecOf(assistantLlm("openrouter", "m"), { openrouter: { credential: "two" } })
    expect(llmKeyOf(one)).toBe(llmKeyOf(two))
    expect(one.credential).not.toBe(two.credential)
  })

  it("OpenRouter's \"Prefer the fastest provider\" changes the instance's identity but not the key shown; a home model ignores it", () => {
    const or = (sortByLatency?: boolean) => llmSpecOf(assistantLlm("openrouter", "m"), { openrouter: { credential: "k", sortByLatency } })
    expect(or(true).sortByLatency).toBe(true)
    expect(or().sortByLatency).toBeUndefined()
    expect(llmKeyOf(or(true))).toBe(llmKeyOf(or(false)))
    expect(llmIdentityOf(or(true))).not.toBe(llmIdentityOf(or(false)))
    expect(llmIdentityOf(or(true))).not.toBe(llmIdentityOf(or()))
    expect(llmIdentityOf(or(true))).toBe(llmIdentityOf(or(true)))
    const accounts = { openrouter: { sortByLatency: true }, "home-model": { address: "http://h:1" } }
    expect(llmSpecOf(assistantLlm("home-model", "m"), accounts).sortByLatency).toBeUndefined()
  })
})

describe("llmConfigOf and llmLabelOf: OpenRouter and home model", () => {
  it("OpenRouter: the settings of OPENROUTER_, the address when there is one", () => {
    expect(llmConfigOf(llmSpecOf(assistantLlm("openrouter", "vendor/m", { warmUp: false })))).toEqual({
      OPENROUTER_MODEL: "vendor/m",
      OPENROUTER_MAX_TOKENS: "300",
      OPENROUTER_TIMEOUT_MS: "4000",
      OPENROUTER_WARM_UP: "false",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1"
    })
  })

  it("home model: HOME_MODEL_ settings, no BASE_URL entry without an address (the shared setting answers)", () => {
    const config = llmConfigOf(llmSpecOf(assistantLlm("home-model", "qwen3")))
    expect(config).toEqual({ HOME_MODEL_MODEL: "qwen3", HOME_MODEL_MAX_TOKENS: "300", HOME_MODEL_TIMEOUT_MS: "4000", HOME_MODEL_WARM_UP: "true" })
    expect(llmConfigOf(llmSpecOf(assistantLlm("home-model", "qwen3"), { "home-model": { address: "http://h:1" } })).HOME_MODEL_BASE_URL).toBe("http://h:1")
  })

  it("OpenRouter: the shared sorting setting is handed to the adapter when set, so a rebuilt instance follows a save", () => {
    const config = (sortByLatency?: boolean) => llmConfigOf(llmSpecOf(assistantLlm("openrouter", "m"), { openrouter: { sortByLatency } }))
    expect(config(false).OPENROUTER_SORT_BY_LATENCY).toBe("false")
    expect(config(true).OPENROUTER_SORT_BY_LATENCY).toBe("true")
    expect("OPENROUTER_SORT_BY_LATENCY" in config()).toBe(false)
  })

  it("never puts the key in the settings", () => {
    const config = llmConfigOf(llmSpecOf(assistantLlm("openrouter", "m"), { openrouter: { credential: "stamp" } }))
    expect(Object.keys(config).some((k) => k.endsWith("API_KEY"))).toBe(false)
    expect(Object.values(config)).not.toContain("stamp")
  })

  it("labels the status entry with the account and the model", () => {
    expect(llmLabelOf(llmSpecOf(assistantLlm("openrouter", "vendor/m")))).toBe("OpenRouter vendor/m")
    expect(llmLabelOf(llmSpecOf(assistantLlm("home-model", "qwen3")))).toBe("Home model qwen3")
  })
})
