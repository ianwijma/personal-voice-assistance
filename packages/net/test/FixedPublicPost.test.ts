// postFixedPublicJson: the host's POST with a JSON body to a fixed public API address (the report filing). Public
// addresses only, sent once (no redirect followed), the helper owns the body's type and length, no loopback option.
// Every request goes to a fake connector: nothing leaves the machine.
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { NetRefused } from "../src/Errors.ts"
import { postFixedPublicJson } from "../src/host.ts"
import { contentTypes, safeFetch } from "../src/SafeFetch.ts"
import { fakeConnector, fakeResolver, reply } from "./helpers.ts"

const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error : undefined
}

describe("postFixedPublicJson", () => {
  it("sends one POST with the JSON body to a public address and reads the JSON answer", async () => {
    const resolver = fakeResolver({ "api.example.org": ["93.184.216.34"] })
    const connector = fakeConnector(() => reply(201, "{\"number\":7}", { "content-type": "application/json" }))
    const answer = await Effect.runPromise(postFixedPublicJson("https://api.example.org/issues", { accept: contentTypes.json, body: { json: { title: "t" } }, headers: { authorization: "Bearer x" }, resolver, connector }))
    expect(answer.status).toBe(201)
    expect(JSON.parse(answer.text())).toEqual({ number: 7 })
    expect(connector.requests).toHaveLength(1)
    const sent = connector.requests[0]!
    expect(sent.method).toBe("POST")
    expect(new TextDecoder().decode(sent.body)).toBe("{\"title\":\"t\"}")
    expect(sent.headers["content-type"]).toBe("application/json")
    expect(sent.headers["authorization"]).toBe("Bearer x")
  })

  it("refuses a private address, a redirect, a caller's Content-Type and the loopback option", async () => {
    const lan = fakeResolver({ "api.example.org": ["192.168.1.5"] })
    const none = fakeConnector(() => reply(201, "{}", { "content-type": "application/json" }))
    expect(await errorOf(postFixedPublicJson("https://api.example.org/x", { accept: contentTypes.json, body: { json: {} }, resolver: lan, connector: none }))).toBeInstanceOf(NetRefused)
    expect(none.requests).toHaveLength(0)

    const resolver = fakeResolver({ "api.example.org": ["93.184.216.34"] })
    const moved = fakeConnector(() => reply(307, "", { location: "https://api.example.org/y" }))
    const redirect = (await errorOf(postFixedPublicJson("https://api.example.org/x", { accept: contentTypes.json, body: { json: {} }, resolver, connector: moved }))) as NetRefused
    expect(redirect.rule).toBe("post-redirect")
    expect(moved.requests).toHaveLength(1)

    const typed = (await errorOf(postFixedPublicJson("https://api.example.org/x", { accept: contentTypes.json, body: { json: {} }, headers: { "content-type": "text/plain" }, resolver, connector: none }))) as NetRefused
    expect(typed.rule).toBe("header")
    const loop = (await errorOf(postFixedPublicJson("https://api.example.org/x", { accept: contentTypes.json, body: { json: {} }, resolver, connector: none, ...({ typedLoopback: true } as object) }))) as NetRefused
    expect(loop.rule).toBe("options")
    expect(none.requests).toHaveLength(0)
  })

  it("sends to https: addresses only", async () => {
    const resolver = fakeResolver({ "api.example.org": ["93.184.216.34"] })
    const connector = fakeConnector(() => reply(201, "{}", { "content-type": "application/json" }))
    const plain = (await errorOf(postFixedPublicJson("http://api.example.org/issues", { accept: contentTypes.json, body: { json: {} }, resolver, connector }))) as NetRefused
    expect(plain.rule).toBe("scheme")
    expect(connector.requests).toHaveLength(0)
  })

  it("is not in the package's main entry, and no module package imports the host entry", async () => {
    const main = await import("../src/index.ts")
    expect("postFixedPublicJson" in main).toBe(false)
    expect("fetchCheckedForHost" in main).toBe(false)
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const { join } = await import("node:path")
    const packages = join(import.meta.dirname, "..", "..")
    const offenders: Array<string> = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules") continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && /["']@pva\/net\/host["']|net\/src\/host/.test(readFileSync(path, "utf8"))) offenders.push(path)
      }
    }
    for (const pkg of readdirSync(packages)) if (pkg.startsWith("module")) walk(join(packages, pkg))
    expect(offenders).toEqual([])
  })

  it("leaves safeFetch GET and HEAD only", async () => {
    const resolver = fakeResolver({ "api.example.org": ["93.184.216.34"] })
    const connector = fakeConnector(() => reply(200, "{}", { "content-type": "application/json" }))
    const refused = (await errorOf(safeFetch("https://api.example.org/x", { accept: contentTypes.json, resolver, connector, ...({ method: "POST", body: { json: {} } } as object) }))) as NetRefused
    expect(refused.rule).toBe("options")
    expect(connector.requests).toHaveLength(0)
  })
})
