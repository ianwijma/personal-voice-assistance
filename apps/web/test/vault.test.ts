import { describe, expect, it } from "vitest"
import type { ServerMessage } from "@pva/protocol"
import { exampleSnapshot, serverExamples } from "@pva/protocol/examples"
import { canChange, engineNeedsKeys, initialState, noVault, reducer } from "@/lib/state.ts"
import { keysView, newPasswordProblem, passwordProblem, retrySecondsLeft, secretStatus } from "@/lib/vault.ts"

const welcomeWith = (vault: typeof exampleSnapshot.vault): ServerMessage => ({
  ...serverExamples.welcome,
  snapshot: vault === undefined ? (({ vault: _v, ...rest }) => rest)(exampleSnapshot) : { ...exampleSnapshot, vault }
})

describe("vault state", () => {
  it("welcome takes the snapshot's vault; a server without one means 'none, everyone may change'", () => {
    expect(reducer(initialState, welcomeWith({ state: "locked", admin: false })).vault).toEqual({ state: "locked", admin: false })
    expect(reducer(initialState, welcomeWith(undefined)).vault).toEqual(noVault)
  })

  it("`vault` messages replace it (admin is this page's own)", () => {
    let s = reducer(initialState, welcomeWith({ state: "unlocked", admin: false }))
    s = reducer(s, { type: "vault", vault: { state: "unlocked", admin: true } })
    expect(s.vault.admin).toBe(true)
    s = reducer(s, serverExamples.vault)
    expect(s.vault).toEqual(serverExamples.vault.vault)
  })

  it("protected items need admin access; unprotected ones never do", () => {
    const locked = reducer(initialState, welcomeWith({ state: "unlocked", admin: false }))
    const admin = reducer(locked, { type: "vault", vault: { state: "unlocked", admin: true } })
    expect(canChange(locked, { protected: true })).toBe(false)
    expect(canChange(locked, {})).toBe(true)
    expect(canChange(locked, undefined)).toBe(true)
    expect(canChange(admin, { protected: true })).toBe(true)
    const none = reducer(initialState, welcomeWith({ state: "none", admin: true }))
    expect(canChange(none, { protected: true })).toBe(true)
  })

  it("engineNeedsKeys: failed engines while the vault is locked", () => {
    const failed = { ...exampleSnapshot.engine, state: "failed" as const, problems: [{ stage: "llm", message: "Keys are locked — unlock them in Options" }] }
    let s = reducer(initialState, welcomeWith({ state: "locked", admin: false }))
    s = reducer(s, { type: "engine", engine: failed })
    expect(engineNeedsKeys(s)).toBe(true)
    expect(engineNeedsKeys(reducer(s, { type: "vault", vault: { state: "unlocked", admin: true } }))).toBe(false)
    expect(engineNeedsKeys(reducer(s, { type: "engine", engine: exampleSnapshot.engine }))).toBe(false)
  })
})

describe("Keys & access logic", () => {
  it("chooses the controls from the vault state and this page's access", () => {
    expect(keysView({ state: "none", admin: true })).toBe("setup")
    expect(keysView({ state: "locked", admin: false })).toBe("unlock")
    expect(keysView({ state: "unlocked", admin: false })).toBe("elevate")
    expect(keysView({ state: "unlocked", admin: true })).toBe("admin")
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
