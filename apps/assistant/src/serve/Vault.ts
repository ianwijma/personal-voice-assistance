import { Config } from "effect"
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto"
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { userCwd } from "../env.ts"
import { flattenSections } from "./flatten.ts"

/**
 * The key vault (docs/UI-AND-MODULES.md §1.6): API keys and tokens in one
 * encrypted file outside the project, so they are not in the checkout or in
 * the environment that tools working on the project can read.
 *
 * - File: `PVA_VAULT_PATH`, default `$XDG_CONFIG_HOME/pva/vault.enc` (else
 *   `~/.config/pva/vault.enc`); mode 0600, a directory it creates gets 0700;
 *   writes are atomic (temporary file, then rename) and serialised.
 * - Crypto: `node:crypto` only. scrypt (N = 2^17, r = 8, p = 1; random 16-byte
 *   salt; parameters stored in the file) derives a 32-byte key; AES-256-GCM
 *   with a fresh 12-byte IV per write encrypts the JSON of the secrets. The
 *   header (format, version, KDF parameters, salt) is the GCM additional data,
 *   so changing any of it makes the file fail to open.
 * - A wrong password and a modified file both fail GCM authentication; the two
 *   cannot be told apart, and neither ever resets the vault. A file that is not
 *   a vault at all is reported as damaged.
 * - The derived key is kept in memory only while unlocked and overwritten on
 *   lock. The password is never stored or logged.
 * - Unlock attempts are rate limited: after 5 failures in a row, refused for
 *   30 s; every further failure doubles the wait (capped at an hour).
 *
 * Forgotten password: delete the vault file; the keys in it are lost.
 */

/**
 * The plaintext: module secrets per module, assistant secrets flat by key (the same shape as `data/secrets.json`
 * version 2, without its version). A vault written before the settings screen keeps assistant secrets per section
 * (`sections`); it is read as flat and written flat at the next change.
 */
export interface VaultSecrets {
  readonly modules: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly assistant: Readonly<Record<string, string>>
}

export type VaultState = "none" | "locked" | "unlocked"

export interface KdfParams {
  readonly N: number
  readonly r: number
  readonly p: number
}

/** Unlock in about 0.3 s on the development machine (measured: 276–302 ms). */
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 }

export const MIN_PASSWORD_LENGTH = 8
const MAX_FAILURES_BEFORE_WAIT = 5
const FIRST_WAIT_MS = 30_000
const MAX_WAIT_MS = 3_600_000
const KEY_BYTES = 32

export type VaultFailure =
  | { readonly reason: "wrong_password"; readonly message: string; readonly retryAfterMs?: number }
  | { readonly reason: "rate_limited"; readonly message: string; readonly retryAfterMs: number }
  | { readonly reason: "too_short"; readonly message: string }
  | { readonly reason: "no_vault"; readonly message: string }
  | { readonly reason: "exists"; readonly message: string }
  | { readonly reason: "locked"; readonly message: string }
  | { readonly reason: "damaged"; readonly message: string }
  | { readonly reason: "io"; readonly message: string }

export type VaultResult = { readonly ok: true } | ({ readonly ok: false } & VaultFailure)

export interface Vault {
  readonly path: string
  readonly state: () => VaultState
  /** The secrets while unlocked; `undefined` otherwise. */
  readonly secrets: () => VaultSecrets | undefined
  /** Milliseconds until an unlock attempt is accepted again (0 = now). */
  readonly retryAfterMs: () => number
  /** Create the vault (only when there is none) with these secrets; leaves it unlocked. */
  readonly setup: (password: string, initial: VaultSecrets, revision?: number) => Promise<VaultResult>
  readonly unlock: (password: string) => Promise<VaultResult>
  /** Forget the key and the secrets. */
  readonly lock: () => void
  /** Re-encrypt under a new password and a new salt. Works locked or unlocked; leaves it unlocked. */
  readonly changePassword: (oldPassword: string, newPassword: string) => Promise<VaultResult>
  /** Replace the secrets (only while unlocked). */
  readonly save: (next: VaultSecrets) => Promise<VaultResult>
  /**
   * Run `f` alone (no unlock, password change or other write in between): the settings store's save, which
   * journals the file's text before replacing it (`SettingsStore.ts`, "Revisions" and the journal).
   */
  readonly exclusive: <A>(f: (writer: VaultWriter) => Promise<A>) => Promise<A>
  /** The secrets in a vault file's text, under the current key; `undefined` while locked or when it does not open with it. */
  readonly decode: (text: string) => VaultSecrets | undefined
}

/** A write of the vault file in steps, inside `Vault.exclusive`. */
export interface VaultWriter {
  /** The file text for `next` under the current key, carrying `revision`; `undefined` while locked. */
  readonly encode: (next: VaultSecrets, revision: number | undefined) => string | undefined
  /** Replace the file with `text` (atomic, 0600). Memory is not changed. */
  readonly writeText: (text: string) => Promise<void>
  /** After the save succeeded: `next` becomes the secrets in memory. */
  readonly adopt: (next: VaultSecrets, revision: number | undefined) => void
}

export interface VaultOptions {
  readonly path: string
  /** Default `DEFAULT_KDF`. Tests use a cheaper N; the parameters are stored in the file, so a vault opens with its own. */
  readonly kdf?: KdfParams
  /** For the rate limit. Default `Date.now`. */
  readonly now?: () => number
}

/** `PVA_VAULT_PATH`, default `$XDG_CONFIG_HOME/pva/vault.enc`, else `~/.config/pva/vault.enc`. */
export const defaultVaultPath = (env: Readonly<Record<string, string | undefined>>): string => {
  const explicit = env.PVA_VAULT_PATH
  if (explicit !== undefined && explicit.trim() !== "") return resolve(userCwd, explicit.trim())
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg !== undefined && xdg.trim() !== "" ? xdg.trim() : join(env.HOME ?? homedir(), ".config")
  return join(base, "pva", "vault.enc")
}

export const VaultPathConfig = Config.all({
  explicit: Config.String("PVA_VAULT_PATH").pipe(Config.withDefault("")),
  xdg: Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(""))
}).pipe(Config.map(({ explicit, xdg }) => defaultVaultPath({ PVA_VAULT_PATH: explicit, XDG_CONFIG_HOME: xdg })))

// ---------------------------------------------------------------------------
// File format

const FORMAT = "pva-vault"

interface VaultFile {
  readonly format: typeof FORMAT
  readonly version: 1
  /**
   * The settings save that wrote this file (`SettingsStore.ts`, "Revisions"), so it can be matched with
   * `settings.json` without the password. Authenticated (part of the additional data) when present.
   */
  readonly revision?: number
  readonly kdf: { readonly name: "scrypt"; readonly N: number; readonly r: number; readonly p: number; readonly salt: string }
  readonly cipher: { readonly name: "aes-256-gcm"; readonly iv: string; readonly tag: string }
  readonly data: string
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)
const isBase64 = (s: unknown, bytes?: number): s is string =>
  typeof s === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(s) && (bytes === undefined || Buffer.from(s, "base64").length === bytes)
const isPowerOfTwo = (n: number) => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0

const parseFile = (text: string): VaultFile | undefined => {
  let u: unknown
  try {
    u = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(u) || u.format !== FORMAT || u.version !== 1 || !isRecord(u.kdf) || !isRecord(u.cipher)) return undefined
  const { kdf, cipher } = u
  // Bounded so a modified file cannot make scrypt allocate gigabytes: at most 256 MB (128 * N * r) and p <= 4.
  const okKdf = kdf.name === "scrypt" && typeof kdf.N === "number" && isPowerOfTwo(kdf.N) &&
    typeof kdf.r === "number" && Number.isInteger(kdf.r) && kdf.r >= 1 && 128 * kdf.N * kdf.r <= 2 ** 28 &&
    typeof kdf.p === "number" && Number.isInteger(kdf.p) && kdf.p >= 1 && kdf.p <= 4 && isBase64(kdf.salt, 16)
  const okCipher = cipher.name === "aes-256-gcm" && isBase64(cipher.iv, 12) && isBase64(cipher.tag, 16)
  const okRevision = u.revision === undefined || (typeof u.revision === "number" && Number.isSafeInteger(u.revision) && u.revision >= 0)
  if (!okKdf || !okCipher || !okRevision || !isBase64(u.data)) return undefined
  return u as unknown as VaultFile
}

/** Whether `text` is a vault file (it may still not open). For the settings journal. */
export const isVaultText = (text: string): boolean => parseFile(text) !== undefined

/** The authenticated header: any change to the parameters or the salt makes decryption fail. */
const additionalData = (kdf: VaultFile["kdf"], revision: number | undefined) =>
  Buffer.from(`${FORMAT}:1:scrypt:${kdf.N}:${kdf.r}:${kdf.p}:${kdf.salt}:aes-256-gcm${revision === undefined ? "" : `:revision=${revision}`}`, "utf8")

const deriveKey = (password: string, salt: Buffer, params: KdfParams): Promise<Buffer> =>
  new Promise((resolvePromise, reject) => {
    // scrypt needs 128 * N * r * p bytes; allow twice that.
    const maxmem = 256 * params.N * params.r * params.p
    scrypt(password.normalize("NFC"), salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem }, (error, key) => {
      if (error !== null) reject(error)
      else resolvePromise(key)
    })
  })

const encrypt = (key: Buffer, kdf: VaultFile["kdf"], secrets: VaultSecrets, revision: number | undefined): VaultFile => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(additionalData(kdf, revision))
  const plaintext = Buffer.from(JSON.stringify({ modules: secrets.modules, assistant: secrets.assistant }), "utf8")
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  plaintext.fill(0)
  return {
    format: FORMAT,
    version: 1,
    ...(revision !== undefined ? { revision } : {}),
    kdf,
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    data: data.toString("base64")
  }
}

const strings = (r: unknown): r is Record<string, string> => isRecord(r) && Object.values(r).every((v) => typeof v === "string")
const group = (g: unknown): g is Record<string, Record<string, string>> => isRecord(g) && Object.values(g).every(strings)

/** The plaintext as `VaultSecrets` (the per-section shape of older vaults flattened), or undefined when it is not one. Exported for tests. */
export const readVaultSecrets = (u: unknown): VaultSecrets | undefined => {
  if (!isRecord(u) || !group(u.modules)) return undefined
  if (strings(u.assistant)) return { modules: u.modules, assistant: u.assistant }
  if (group(u.sections)) return { modules: u.modules, assistant: flattenSections(u.sections, "key vault").flat }
  return undefined
}

/** `undefined`: authentication failed (wrong key or a modified file). */
const decrypt = (key: Buffer, file: VaultFile): VaultSecrets | undefined => {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"))
  decipher.setAAD(additionalData(file.kdf, file.revision))
  decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"))
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()])
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"))
    return readVaultSecrets(parsed)
  } catch {
    return undefined
  } finally {
    plaintext.fill(0)
  }
}

const exists = async (path: string) => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ---------------------------------------------------------------------------

/** Open the vault at `path` (reads only whether it exists; it starts `locked` or `none`). */
export const openVault = async (options: VaultOptions): Promise<Vault> => {
  const path = options.path
  const params = options.kdf ?? DEFAULT_KDF
  const now = options.now ?? Date.now
  let present = await exists(path)
  let key: Buffer | undefined
  let kdf: VaultFile["kdf"] | undefined
  let secrets: VaultSecrets | undefined
  /** The revision of the file as last opened or written (kept by a password change and by `save`). */
  let revision: number | undefined
  let failures = 0
  let blockedUntil = 0

  // Every operation runs alone (no unlock racing a save or a password change).
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <A>(f: () => Promise<A>): Promise<A> => {
    const next = queue.then(f)
    queue = next.catch(() => {})
    return next
  }

  const fileText = (file: VaultFile) => `${JSON.stringify(file, null, 2)}\n`
  const write = (file: VaultFile) => writeText(fileText(file))
  const writeText = async (text: string) => {
    const dir = dirname(path)
    const dirExisted = await exists(dir)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (!dirExisted) await chmod(dir, 0o700)
    const tmp = `${path}.tmp`
    await writeFile(tmp, text, { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
    present = true
  }

  const forget = () => {
    key?.fill(0)
    key = undefined
    kdf = undefined
    secrets = undefined
  }

  const freshKdf = async (password: string): Promise<{ key: Buffer; kdf: VaultFile["kdf"] }> => {
    const salt = randomBytes(16)
    const derived = await deriveKey(password, salt, params)
    return { key: derived, kdf: { name: "scrypt", N: params.N, r: params.r, p: params.p, salt: salt.toString("base64") } }
  }

  const tooShort = (password: string): VaultResult | undefined =>
    password.length < MIN_PASSWORD_LENGTH
      ? { ok: false, reason: "too_short", message: `The password must be at least ${MIN_PASSWORD_LENGTH} characters` }
      : undefined

  const retryAfterMs = () => Math.max(0, blockedUntil - now())

  const failed = (): VaultResult => {
    failures++
    if (failures >= MAX_FAILURES_BEFORE_WAIT) {
      const wait = Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (failures - MAX_FAILURES_BEFORE_WAIT))
      blockedUntil = now() + wait
      return {
        ok: false,
        reason: "wrong_password",
        message: `Wrong password. Too many attempts: try again in ${Math.ceil(wait / 1000)} s`,
        retryAfterMs: wait
      }
    }
    return { ok: false, reason: "wrong_password", message: "Wrong password (or the vault file was changed)" }
  }

  /** Read the file and check the password; does not change the state. */
  const open = async (password: string): Promise<
    { ok: true; key: Buffer; kdf: VaultFile["kdf"]; secrets: VaultSecrets; revision: number | undefined } | ({ ok: false } & VaultFailure)
  > => {
    if (!(await exists(path))) {
      present = false
      return { ok: false, reason: "no_vault", message: `There is no vault at ${path}` }
    }
    const wait = retryAfterMs()
    if (wait > 0) {
      return { ok: false, reason: "rate_limited", message: `Too many wrong passwords: try again in ${Math.ceil(wait / 1000)} s`, retryAfterMs: wait }
    }
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      return { ok: false, reason: "io", message: `Could not read the vault at ${path}: ${describeError(error)}` }
    }
    const file = parseFile(text)
    if (file === undefined) {
      return {
        ok: false,
        reason: "damaged",
        message: `The vault at ${path} is damaged or is not a vault; it was not opened and was left as it is. ` +
          "Restore it from a backup, or delete it (the keys in it are lost) and set a new password."
      }
    }
    const salt = Buffer.from(file.kdf.salt, "base64")
    let derived: Buffer
    try {
      derived = await deriveKey(password, salt, file.kdf)
    } catch (error) {
      return { ok: false, reason: "damaged", message: `The vault at ${path} could not be opened: ${describeError(error)}` }
    }
    const opened = decrypt(derived, file)
    if (opened === undefined) {
      derived.fill(0)
      const result = failed()
      return result as { ok: false } & VaultFailure
    }
    failures = 0
    blockedUntil = 0
    return { ok: true, key: derived, kdf: file.kdf, secrets: opened, revision: file.revision }
  }

  return {
    path,
    state: () => (secrets !== undefined ? "unlocked" : present ? "locked" : "none"),
    secrets: () => secrets,
    retryAfterMs,
    setup: (password, initial, initialRevision) =>
      serial(async (): Promise<VaultResult> => {
        if (present || (await exists(path))) {
          present = true
          return { ok: false, reason: "exists", message: `A vault already exists at ${path}` }
        }
        const short = tooShort(password)
        if (short !== undefined) return short
        const fresh = await freshKdf(password)
        try {
          await write(encrypt(fresh.key, fresh.kdf, initial, initialRevision))
        } catch (error) {
          fresh.key.fill(0)
          return { ok: false, reason: "io", message: `Could not write the vault at ${path}: ${describeError(error)}` }
        }
        forget()
        key = fresh.key
        kdf = fresh.kdf
        secrets = initial
        revision = initialRevision
        return { ok: true }
      }),
    unlock: (password) =>
      serial(async (): Promise<VaultResult> => {
        const opened = await open(password)
        if (!opened.ok) return opened
        forget()
        key = opened.key
        kdf = opened.kdf
        secrets = opened.secrets
        revision = opened.revision
        return { ok: true }
      }),
    lock: forget,
    changePassword: (oldPassword, newPassword) =>
      serial(async (): Promise<VaultResult> => {
        const short = tooShort(newPassword)
        if (short !== undefined) return short
        const opened = await open(oldPassword)
        if (!opened.ok) return opened
        opened.key.fill(0)
        const fresh = await freshKdf(newPassword)
        try {
          await write(encrypt(fresh.key, fresh.kdf, opened.secrets, opened.revision))
        } catch (error) {
          fresh.key.fill(0)
          return { ok: false, reason: "io", message: `Could not write the vault at ${path}: ${describeError(error)}` }
        }
        forget()
        key = fresh.key
        kdf = fresh.kdf
        secrets = opened.secrets
        revision = opened.revision
        return { ok: true }
      }),
    save: (next) =>
      serial(async (): Promise<VaultResult> => {
        if (key === undefined || kdf === undefined) return { ok: false, reason: "locked", message: "The keys are locked" }
        try {
          await write(encrypt(key, kdf, next, revision))
        } catch (error) {
          return { ok: false, reason: "io", message: `Could not write the vault at ${path}: ${describeError(error)}` }
        }
        secrets = next
        return { ok: true }
      }),
    exclusive: (f) =>
      serial(() =>
        f({
          encode: (next, nextRevision) => {
            if (key === undefined || kdf === undefined) return undefined
            return fileText(encrypt(key, kdf, next, nextRevision))
          },
          writeText,
          adopt: (next, nextRevision) => {
            revision = nextRevision
            if (key !== undefined) secrets = next
          }
        })
      ),
    decode: (text) => {
      if (key === undefined || kdf === undefined) return undefined
      const file = parseFile(text)
      if (file === undefined || file.kdf.salt !== kdf.salt) return undefined
      return decrypt(key, file)
    }
  }
}

