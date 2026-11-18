// The key vault (src/serve/Vault.ts) and the settings store on top of it. Temporary directories only.
import { Effect } from "effect"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bound } from "../../../packages/store-sqlite/test/latencyBound.ts"
import { KEYS_LOCKED_MESSAGE, loadSettingsStore, type SaveStep } from "../src/serve/SettingsStore.ts"
import { DEFAULT_KDF, defaultVaultPath, openVault, type VaultSecrets } from "../src/serve/Vault.ts"
import { openStore } from "./support/store.ts"

const kdf = { N: 2 ** 12, r: 8, p: 1 }
const temp = () => mkdtempSync(join(tmpdir(), "pva-vault-"))
const secrets: VaultSecrets = {
  modules: { "home-assistant": { token: "ha-token" } },
  assistant: { ANTHROPIC_API_KEY: "sk-ant-test" }
}
const open = (path: string, now?: () => number) => openVault({ path, kdf, ...(now !== undefined ? { now } : {}) })

describe("vault: file and crypto", () => {
  it("round trip: setup → locked after a restart → unlock with the password → the same secrets", async () => {
    const path = join(temp(), "pva", "vault.enc")
    const first = await open(path)
    expect(first.state()).toBe("none")
    expect(await first.setup("correct horse", secrets)).toEqual({ ok: true })
    expect(first.state()).toBe("unlocked")
    expect(first.secrets()).toEqual(secrets)

    // The file holds no secret in the clear, and records its own scrypt parameters.
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain("sk-ant-test")
    expect(text).not.toContain("ha-token")
    const file = JSON.parse(text)
    expect(file).toMatchObject({ format: "pva-vault", version: 1, kdf: { name: "scrypt", N: kdf.N, r: 8, p: 1 }, cipher: { name: "aes-256-gcm" } })
    expect(Buffer.from(file.kdf.salt, "base64")).toHaveLength(16)
    expect(Buffer.from(file.cipher.iv, "base64")).toHaveLength(12)

    const restarted = await open(path)
    expect(restarted.state()).toBe("locked")
    expect(restarted.secrets()).toBeUndefined()
    expect(await restarted.unlock("correct horse")).toEqual({ ok: true })
    expect(restarted.secrets()).toEqual(secrets)
    restarted.lock()
    expect(restarted.state()).toBe("locked")
    expect(restarted.secrets()).toBeUndefined()
  })

  it("a wrong password does not open it (and does not lock an unlocked vault)", async () => {
    const path = join(temp(), "vault.enc")
    const vault = await open(path)
    await vault.setup("correct horse", secrets)
    const result = await vault.unlock("wrong horse")
    expect(result).toMatchObject({ ok: false, reason: "wrong_password" })
    expect(vault.state()).toBe("unlocked")

    const other = await open(path)
    expect(await other.unlock("Correct horse")).toMatchObject({ ok: false, reason: "wrong_password" })
    expect(other.state()).toBe("locked")
  })

  it("a new IV for every write", async () => {
    const path = join(temp(), "vault.enc")
    const vault = await open(path)
    await vault.setup("correct horse", secrets)
    const iv1 = JSON.parse(readFileSync(path, "utf8")).cipher.iv
    await vault.save({ ...secrets, assistant: {} })
    const iv2 = JSON.parse(readFileSync(path, "utf8")).cipher.iv
    expect(iv2).not.toBe(iv1)
    const reopened = await open(path)
    await reopened.unlock("correct horse")
    expect(reopened.secrets()).toEqual({ ...secrets, assistant: {} })
  })

  it("tampering: a changed byte, a changed parameter or salt fails to open; garbage is reported as damaged; the file is never reset", async () => {
    const path = join(temp(), "vault.enc")
    const vault = await open(path)
    await vault.setup("correct horse", secrets)
    const original = readFileSync(path, "utf8")
    const file = JSON.parse(original)

    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, "base64")
      bytes[0] = bytes[0]! ^ 1
      return bytes.toString("base64")
    }
    const variants = [
      { ...file, data: flip(file.data) },
      { ...file, cipher: { ...file.cipher, tag: flip(file.cipher.tag) } },
      { ...file, cipher: { ...file.cipher, iv: flip(file.cipher.iv) } },
      { ...file, kdf: { ...file.kdf, salt: flip(file.kdf.salt) } },
      { ...file, kdf: { ...file.kdf, N: file.kdf.N * 2 } }
    ]
    for (const variant of variants) {
      const text = JSON.stringify(variant)
      writeFileSync(path, text)
      const v = await open(path)
      expect(await v.unlock("correct horse")).toMatchObject({ ok: false, reason: "wrong_password" })
      expect(v.state()).toBe("locked")
      expect(readFileSync(path, "utf8")).toBe(text)
    }

    writeFileSync(path, "not a vault")
    const damaged = await open(path)
    expect(damaged.state()).toBe("locked")
    const result = await damaged.unlock("correct horse")
    expect(result).toMatchObject({ ok: false, reason: "damaged" })
    expect(!result.ok && result.message).toMatch(/damaged or is not a vault; it was not opened/)
    expect(readFileSync(path, "utf8")).toBe("not a vault")
    expect(await damaged.setup("another password", secrets)).toMatchObject({ ok: false, reason: "exists" })

    writeFileSync(path, original)
    const restored = await open(path)
    expect(await restored.unlock("correct horse")).toEqual({ ok: true })
  })

  it("change password: needs the old one, re-encrypts with a new salt; the old password stops working", async () => {
    const path = join(temp(), "vault.enc")
    const vault = await open(path)
    await vault.setup("correct horse", secrets)
    const salt1 = JSON.parse(readFileSync(path, "utf8")).kdf.salt
    expect(await vault.changePassword("wrong horse", "battery staple")).toMatchObject({ ok: false, reason: "wrong_password" })
    expect(await vault.changePassword("correct horse", "short")).toMatchObject({ ok: false, reason: "too_short" })
    expect(await vault.changePassword("correct horse", "battery staple")).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(path, "utf8")).kdf.salt).not.toBe(salt1)
    expect(vault.secrets()).toEqual(secrets)

    const reopened = await open(path)
    expect(await reopened.unlock("correct horse")).toMatchObject({ ok: false, reason: "wrong_password" })
    expect(await reopened.unlock("battery staple")).toEqual({ ok: true })
    expect(reopened.secrets()).toEqual(secrets)
  })

  it("setup needs at least 8 characters and only works once; save needs it unlocked", async () => {
    const path = join(temp(), "vault.enc")
    const vault = await open(path)
    expect(await vault.setup("1234567", secrets)).toMatchObject({ ok: false, reason: "too_short" })
    expect(existsSync(path)).toBe(false)
    expect(await vault.setup("12345678", secrets)).toEqual({ ok: true })
    expect(await vault.setup("12345678", secrets)).toMatchObject({ ok: false, reason: "exists" })
    vault.lock()
    expect(await vault.save(secrets)).toMatchObject({ ok: false, reason: "locked" })
  })

  it("file mode 0600, a directory it creates 0700", async () => {
    const dir = join(temp(), "config", "pva")
    const path = join(dir, "vault.enc")
    const vault = await open(path)
    await vault.setup("correct horse", secrets)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    await vault.save(secrets)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it("rate limit: after 5 wrong passwords refused for 30 s, then the wait doubles; a right password resets it", async () => {
    const path = join(temp(), "vault.enc")
    await (await open(path)).setup("correct horse", secrets)
    let now = 1_000_000
    const vault = await open(path, () => now)
    for (let i = 0; i < 4; i++) expect(await vault.unlock("nope nope")).toMatchObject({ ok: false, reason: "wrong_password" })
    expect(vault.retryAfterMs()).toBe(0)
    expect(await vault.unlock("nope nope")).toMatchObject({ ok: false, reason: "wrong_password", retryAfterMs: 30_000 })
    expect(vault.retryAfterMs()).toBe(30_000)
    // Even the right password is refused while waiting (without being checked).
    expect(await vault.unlock("correct horse")).toMatchObject({ ok: false, reason: "rate_limited", retryAfterMs: 30_000 })
    now += 29_000
    expect(await vault.unlock("correct horse")).toMatchObject({ ok: false, reason: "rate_limited", retryAfterMs: 1_000 })
    now += 1_000
    expect(await vault.unlock("nope nope")).toMatchObject({ ok: false, reason: "wrong_password", retryAfterMs: 60_000 })
    now += 60_000
    expect(await vault.unlock("nope nope")).toMatchObject({ ok: false, reason: "wrong_password", retryAfterMs: 120_000 })
    now += 120_000
    expect(await vault.unlock("correct horse")).toEqual({ ok: true })
    expect(vault.retryAfterMs()).toBe(0)
    vault.lock()
    for (let i = 0; i < 4; i++) await vault.unlock("nope nope")
    expect(vault.retryAfterMs()).toBe(0)
  })

  it("the default path is outside the project: PVA_VAULT_PATH, else $XDG_CONFIG_HOME/pva, else ~/.config/pva", () => {
    expect(defaultVaultPath({ PVA_VAULT_PATH: "/srv/keys/v.enc" })).toBe("/srv/keys/v.enc")
    expect(defaultVaultPath({ XDG_CONFIG_HOME: "/home/x/.cfg" })).toBe("/home/x/.cfg/pva/vault.enc")
    expect(defaultVaultPath({ HOME: "/home/x" })).toBe("/home/x/.config/pva/vault.enc")
    expect(DEFAULT_KDF).toEqual({ N: 2 ** 17, r: 8, p: 1 })
  })

  it("unlock time with the real parameters stays under a second", async () => {
    const path = join(temp(), "vault.enc")
    await (await openVault({ path })).setup("correct horse", secrets)
    const vault = await openVault({ path })
    const start = performance.now()
    expect(await vault.unlock("correct horse")).toEqual({ ok: true })
    const ms = performance.now() - start
    console.log(`vault unlock (scrypt N=2^17, r=8, p=1): ${ms.toFixed(0)} ms`)
    // Shared CI runners are several times slower than a development machine (2.6 s there on 2026-11-18): three times the
    // bound on CI, as the store's latency tests (this file is one of them, so CI runs it alone).
    expect(ms).toBeLessThan(bound(1_000))
  })
})

describe("vault: the settings store on top of it", () => {
  const legacy = { version: 1, modules: { greeter: { token: "from-json" } }, sections: { "language-model": { ANTHROPIC_API_KEY: "sk-json" } } }

  it("before a vault exists, secrets stay in data/secrets.json; after setup they move into the vault and the file is deleted", async () => {
    const dir = temp()
    writeFileSync(join(dir, "secrets.json"), JSON.stringify(legacy), { mode: 0o600 })
    const vault = await open(join(dir, "keys", "vault.enc"))
    const store = await Effect.runPromise(openStore(dir, { vault }))
    expect(store.secrets().modules.greeter).toEqual({ token: "from-json" })
    expect(store.legacySecretCount()).toBe(2)

    expect(await vault.setup("correct horse", { modules: {}, assistant: {} })).toEqual({ ok: true })
    expect(await Effect.runPromise(store.importLegacySecrets())).toBe(2)
    expect(existsSync(join(dir, "secrets.json"))).toBe(false)
    expect(store.legacySecretCount()).toBe(0)
    expect(vault.secrets()).toEqual({ modules: legacy.modules, assistant: { ANTHROPIC_API_KEY: "sk-json" } })
    expect(store.secrets().assistant).toEqual({ ANTHROPIC_API_KEY: "sk-json" })

    // New secrets go to the vault only (flat by key, like every assistant setting).
    await Effect.runPromise(store.saveAssistant(["STT_PROVIDER", "DEEPGRAM_API_KEY"], { STT_PROVIDER: "deepgram" }, { DEEPGRAM_API_KEY: "dg" }))
    expect(existsSync(join(dir, "secrets.json"))).toBe(false)
    expect(vault.secrets()?.assistant).toEqual({ ANTHROPIC_API_KEY: "sk-json", DEEPGRAM_API_KEY: "dg" })
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toMatchObject({ version: 5, assistant: { STT_PROVIDER: "deepgram" } })
    expect(readFileSync(join(dir, "settings.json"), "utf8")).not.toContain("dg\"")
  })

  it("while locked: no secrets, a secret change is refused (and nothing is saved), other settings still save", async () => {
    const dir = temp()
    const path = join(dir, "vault.enc")
    await (await open(path)).setup("correct horse", secrets)
    const vault = await open(path)
    const store = await Effect.runPromise(openStore(dir, { vault }))
    expect(store.secrets()).toEqual({ version: 2, modules: {}, assistant: {} })
    const refused = await Effect.runPromise(
      Effect.flip(store.saveAssistant(["LLM_PROVIDER", "ANTHROPIC_API_KEY"], { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "new" }))
    )
    expect(refused.message).toBe(KEYS_LOCKED_MESSAGE)
    expect(existsSync(join(dir, "settings.json"))).toBe(false)
    await Effect.runPromise(store.saveAssistant(["DEFAULT_VOICE", "VOICES"], { DEFAULT_VOICE: "natural" }, {}))
    expect(store.settings().assistant).toEqual({ DEFAULT_VOICE: "natural" })
    // Saving a module with the (empty) secrets it sees while locked does not wipe the vault.
    await Effect.runPromise(store.saveModule("home-assistant", { enabled: true, settings: {}, secrets: {} }))
    await vault.unlock("correct horse")
    expect(store.secrets().modules["home-assistant"]).toEqual({ token: "ha-token" })
  })

  it("a secrets.json that comes back after setup is merged at the next import (the vault's values win)", async () => {
    const dir = temp()
    const path = join(dir, "vault.enc")
    await (await open(path)).setup("correct horse", { modules: { greeter: { token: "in-vault" } }, assistant: {} })
    writeFileSync(join(dir, "secrets.json"), JSON.stringify(legacy), { mode: 0o600 })
    const vault = await open(path)
    const store = await Effect.runPromise(openStore(dir, { vault }))
    await vault.unlock("correct horse")
    expect(await Effect.runPromise(store.importLegacySecrets())).toBe(2)
    expect(vault.secrets()).toEqual({ modules: { greeter: { token: "in-vault" } }, assistant: { ANTHROPIC_API_KEY: "sk-json" } })
    expect(existsSync(join(dir, "secrets.json"))).toBe(false)
  })
})

describe("vault: a save is one transaction over settings.json and the vault file (journal and revisions)", () => {
  const PASSWORD = "correct horse"
  const setupDir = async () => {
    const dir = temp()
    const path = join(dir, "keys", "vault.enc")
    await (await open(path)).setup(PASSWORD, { modules: {}, assistant: {} })
    return { dir, path }
  }
  const unlockedStore = async (dir: string, path: string, options: { beforeStep?: (step: SaveStep) => void } = {}) => {
    const vault = await open(path)
    // As serve mode does: the store loads (and recovers an unfinished save) first, then the keys are unlocked.
    const store = await Effect.runPromise(openStore(dir, { vault, ...options }))
    await vault.unlock(PASSWORD)
    return { vault, store }
  }
  const committed = { values: { LLM_PROVIDER: "anthropic" }, secrets: { ANTHROPIC_API_KEY: "k-old" } }
  const next = { values: { LLM_PROVIDER: "fake" }, secrets: {} }
  const keys = ["LLM_PROVIDER", "ANTHROPIC_API_KEY"]
  /** What a restart on `dir` loads (the vault at `dir/keys/vault.enc`, unlocked once the store has loaded). */
  const restartSees = async (dir: string) => {
    const { store } = await unlockedStore(dir, join(dir, "keys", "vault.enc"))
    return { values: { LLM_PROVIDER: store.settings().assistant.LLM_PROVIDER }, secrets: { ...store.secrets().assistant }, blocked: store.blocked() }
  }
  const revision = (text: string) => (JSON.parse(text) as { revision?: number }).revision

  it("both files carry the save's revision; the journal holds only the vault's encrypted text", async () => {
    const { dir, path } = await setupDir()
    let journal = ""
    const { store } = await unlockedStore(dir, path, {
      beforeStep: (step) => {
        if (step === "secrets") journal = readFileSync(join(dir, "transaction.json"), "utf8")
      }
    })
    await Effect.runPromise(store.saveAssistant(keys, committed.values, committed.secrets))
    const r = revision(readFileSync(join(dir, "settings.json"), "utf8"))
    expect(r).toBeTypeOf("number")
    expect(revision(readFileSync(path, "utf8"))).toBe(r)
    expect(JSON.parse(journal)).toMatchObject({ version: 2, secrets: "vault" })
    expect(journal).not.toContain("k-old")
    expect(statSync(join(dir, "keys", "vault.enc")).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dir, "transaction.json"))).toBe(false)
  })

  it("a crash between any two steps: a restart loads either the committed state or the new one, never a mix", async () => {
    const { dir, path } = await setupDir()
    const first = await unlockedStore(dir, path)
    await Effect.runPromise(first.store.saveAssistant(keys, committed.values, committed.secrets))
    const crashes: Array<{ step: SaveStep; dir: string }> = []
    const { store } = await unlockedStore(dir, path, {
      beforeStep: (step) => {
        const to = temp()
        cpSync(dir, to, { recursive: true })
        rmSync(join(to, "writer.lock"), { force: true })
        crashes.push({ step, dir: to })
      }
    })
    await Effect.runPromise(store.saveAssistant(keys, next.values, next.secrets))
    expect(crashes.map((c) => c.step)).toEqual(["journal", "secrets", "settings", "journal-remove"])
    for (const crash of crashes) {
      const seen = await restartSees(crash.dir)
      const want = crash.step === "journal-remove" ? next : committed
      expect({ values: seen.values, secrets: seen.secrets }, `crash before ${crash.step}`).toEqual(want)
      expect(seen.blocked).toBeUndefined()
    }
  })

  for (const steps of [["settings"], ["settings", "rollback"]] as const) {
    it(`failure at ${steps.join(" + ")}: the save fails, memory and a restart keep the committed state`, async () => {
      const { dir, path } = await setupDir()
      const first = await unlockedStore(dir, path)
      await Effect.runPromise(first.store.saveAssistant(keys, committed.values, committed.secrets))
      const { store, vault } = await unlockedStore(dir, path, {
        beforeStep: (step) => {
          if ((steps as ReadonlyArray<string>).includes(step)) throw new Error(`injected failure at ${step}`)
        }
      })
      const result = await Effect.runPromise(Effect.result(store.saveAssistant(keys, next.values, next.secrets)))
      expect(result._tag).toBe("Failure")
      expect(vault.secrets()?.assistant).toEqual(committed.secrets)
      const seen = await restartSees(dir)
      expect({ values: seen.values, secrets: seen.secrets }).toEqual(committed)
    })
  }

  it("while locked, a settings-only save writes settings.json alone, with the vault's revision (still one save)", async () => {
    const { dir, path } = await setupDir()
    const first = await unlockedStore(dir, path)
    await Effect.runPromise(first.store.saveAssistant(keys, committed.values, committed.secrets))
    const vaultBefore = readFileSync(path, "utf8")
    const vault = await open(path)
    const store = await Effect.runPromise(openStore(dir, { vault }))
    await Effect.runPromise(store.saveAssistant(["DEFAULT_VOICE", "VOICES"], { DEFAULT_VOICE: "natural" }, {}))
    expect(readFileSync(path, "utf8")).toBe(vaultBefore)
    expect(revision(readFileSync(join(dir, "settings.json"), "utf8"))).toBe(revision(vaultBefore))
    const seen = await restartSees(dir)
    expect(seen.blocked).toBeUndefined()
    expect(seen.secrets).toEqual(committed.secrets)
  })

  it("settings.json and the vault from two different saves block the start until a save", async () => {
    const { dir, path } = await setupDir()
    const first = await unlockedStore(dir, path)
    await Effect.runPromise(first.store.saveAssistant(keys, committed.values, committed.secrets))
    const oldSettings = readFileSync(join(dir, "settings.json"), "utf8")
    await Effect.runPromise(first.store.saveAssistant(keys, next.values, next.secrets))
    writeFileSync(join(dir, "settings.json"), oldSettings) // what a damaged journal could leave
    const { store } = await unlockedStore(dir, path)
    expect(store.blocked()).toContain("the key vault")
    await Effect.runPromise(store.saveAssistant(keys, next.values, next.secrets))
    expect(store.blocked()).toBeUndefined()
    expect((await restartSees(dir)).blocked).toBeUndefined()
  })

  it("a read-only load (the CLI) beside a half-done save reads the committed state from the journal", async () => {
    const { dir, path } = await setupDir()
    const first = await unlockedStore(dir, path)
    await Effect.runPromise(first.store.saveAssistant(keys, committed.values, committed.secrets))
    let midSave: string | undefined
    const { store } = await unlockedStore(dir, path, {
      beforeStep: (step) => {
        if (step === "settings" && midSave === undefined) {
          midSave = temp()
          cpSync(dir, midSave, { recursive: true })
        }
      }
    })
    await Effect.runPromise(store.saveAssistant(keys, next.values, next.secrets))
    const vault = await open(join(midSave!, "keys", "vault.enc"))
    await vault.unlock(PASSWORD)
    // The vault file there already holds the new keys; the reader takes the journal's committed text instead.
    expect(vault.secrets()?.assistant).toEqual({})
    const reader = await Effect.runPromise(loadSettingsStore(midSave!, { readOnly: true, vault }))
    expect(reader.secrets().assistant).toEqual(committed.secrets)
    expect(reader.settings().assistant.LLM_PROVIDER).toBe("anthropic")
  })
})
