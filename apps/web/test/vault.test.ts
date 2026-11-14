import { describe, expect, it } from "vitest"
import type { ServerMessage } from "@pva/protocol"
import { exampleAdminSnapshot, exampleEngineStatus, serverExamples } from "@pva/protocol/examples"
import { engineNeedsKeys, initialState, noVault, reducer } from "@/lib/state.ts"
import { keysView, newPasswordProblem, passwordProblem, retrySecondsLeft, secretStatus } from "@/lib/vault.ts"

// Protocol 5 sends the vault in `admin.snapshot` (admin connections only), not in `welcome`.
const welcomeWith = (vault: typeof exampleAdminSnapshot.vault | undefined): Array<ServerMessage> => [
  serverExamples.welcome,
  ...(vault === undefined ? [] : [{ type: "admin.snapshot" as const, snapshot: { ...exampleAdminSnapshot, vault } }])
]
const reduceAll = (s: typeof initialState, ms: ReadonlyArray<ServerMessage>) => ms.reduce(reducer, s)

describe("vault state", () => {
  it("the admin snapshot carries the vault; without one (a voice page) it is unknown and nothing is admin", () => {
    expect(reduceAll(initialState, welcomeWith({ state: "locked", admin: false })).vault).toEqual({ state: "locked", admin: false })
    expect(reduceAll(initialState, welcomeWith(undefined)).vault).toEqual(noVault)
  })

  it("`vault` messages replace it (admin is this page's own)", () => {
    let s = reduceAll(initialState, welcomeWith({ state: "unlocked", admin: false }))
    s = reducer(s, { type: "vault", vault: { state: "unlocked", admin: true } })
    expect(s.vault.admin).toBe(true)
    s = reducer(s, serverExamples.vault)
    expect(s.vault).toEqual(serverExamples.vault.vault)
  })

  it("engineNeedsKeys: failed engines while the vault is locked", () => {
    const failed = { ...exampleEngineStatus, state: "failed" as const, problems: [{ stage: "llm", message: "Keys are locked — unlock them in Options" }] }
    let s = reduceAll(initialState, welcomeWith({ state: "locked", admin: false }))
    s = reducer(s, { type: "engine", engine: failed })
    expect(engineNeedsKeys(s)).toBe(true)
    expect(engineNeedsKeys(reducer(s, { type: "vault", vault: { state: "unlocked", admin: true } }))).toBe(false)
    expect(engineNeedsKeys(reducer(s, { type: "engine", engine: exampleEngineStatus }))).toBe(false)
  })
})

describe("Keys & vault logic", () => {
  it("chooses the controls from the vault state only (who may change things is the admin login since protocol 5)", () => {
    expect(keysView({ state: "none", admin: true })).toBe("setup")
    expect(keysView({ state: "locked", admin: true })).toBe("unlock")
    expect(keysView({ state: "unlocked", admin: true })).toBe("unlocked")
    expect(keysView({ state: "unlocked", admin: false })).toBe("unlocked")
  })

  it("checks a new password before sending it", () => {
    expect(newPasswordProblem("short", "short")).toMatch(/at least 8/)
    expect(newPasswordProblem("long enough", "long enougj")).toMatch(/not the same/)
    expect(newPasswordProblem("x".repeat(257), "x".repeat(257))).toMatch(/at most 256/)
    expect(newPasswordProblem("long enough", "long enough")).toBeUndefined()
    expect(passwordProblem("")).toMatch(/Type the password/)
    expect(passwordProblem("whatever")).toBeUndefined()
  })

  it("counts down a refusal", () => {
    expect(retrySecondsLeft(undefined, 0, 10_000)).toBe(0)
    expect(retrySecondsLeft(30_000, 1_000, 1_000)).toBe(30)
    expect(retrySecondsLeft(30_000, 1_000, 21_500)).toBe(10)
    expect(retrySecondsLeft(30_000, 1_000, 40_000)).toBe(0)
  })

  it("describes a secret: from .env (not protected), in the vault, saved here, locked, not set", () => {
    const unlocked = { state: "unlocked", admin: true } as const
    expect(secretStatus({ set: true, source: "env" }, unlocked, "ANTHROPIC_API_KEY")).toBe("Set by ANTHROPIC_API_KEY in .env (not protected)")
    expect(secretStatus({ set: true, source: "store" }, unlocked, undefined)).toBe("Set (in the key vault)")
    expect(secretStatus({ set: true, source: "store" }, noVault, undefined)).toBe("Set (saved here)")
    expect(secretStatus({ set: false, source: "none" }, { state: "locked", admin: false }, undefined)).toBe("Keys are locked")
    expect(secretStatus({ set: false, source: "none" }, unlocked, undefined)).toBe("Not set")
  })
})
