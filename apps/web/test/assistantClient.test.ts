import { describe, expect, it, vi } from "vitest"
import { exampleAssistant } from "@pva/protocol/examples"
import type { ResultMessage } from "@/lib/connection.ts"
import { createAssistantClient } from "@/lib/client.ts"

const ok = (extra: Partial<ResultMessage> = {}): ResultMessage => ({ type: "result", requestId: "r", ok: true, ...extra }) as ResultMessage
const refused = (error: NonNullable<ResultMessage["error"]>): ResultMessage => ({ type: "result", requestId: "r", ok: false, error })

/** A client whose connection records what it is asked and answers what the test says. */
const clientAnswering = (answer: ResultMessage) => {
  const client = createAssistantClient()
  const request = vi.spyOn(client.connection, "request").mockResolvedValue(answer)
  const toasts = () => client.store.get().toasts.map((t) => t.message)
  return { client, request, toasts }
}

describe("the assistant calls of the client", () => {
  it("saveAssistant sends the whole assistant, adds saveAnyway only when asked, and answers an outcome", async () => {
    const { client, request } = clientAnswering(ok())
    expect(await client.saveAssistant(exampleAssistant)).toEqual({ kind: "ok", assistantId: undefined })
    expect(request).toHaveBeenLastCalledWith({ type: "assistant.save", assistant: exampleAssistant })
    await client.saveAssistant(exampleAssistant, { saveAnyway: true })
    expect(request).toHaveBeenLastCalledWith({ type: "assistant.save", assistant: exampleAssistant, saveAnyway: true })
    await client.saveAssistant(exampleAssistant, { saveAnyway: false })
    expect(request).toHaveBeenLastCalledWith({ type: "assistant.save", assistant: exampleAssistant })
  })

  it("createAssistant carries the id the server chose back, and sends copyOf and placements (phrase only when given)", async () => {
    const { client, request } = clientAnswering(ok({ assistantId: "mia" }))
    const { id: _i, rev: _r, ...body } = exampleAssistant
    expect(await client.createAssistant(body)).toEqual({ kind: "ok", assistantId: "mia" })
    expect(request).toHaveBeenLastCalledWith({ type: "assistant.create", assistant: body })
    await client.createAssistant(body, {
      copyOf: "jeff",
      placements: [{ target: { kind: "device", id: "d1" }, phrase: "hey mia" }, { target: { kind: "type", type: "web-voice" } }]
    })
    expect(request).toHaveBeenLastCalledWith({
      type: "assistant.create",
      assistant: body,
      copyOf: "jeff",
      placements: [{ target: { kind: "device", id: "d1" }, phrase: "hey mia" }, { target: { kind: "type", type: "web-voice" } }]
    })
  })

  it("deleteAssistant names the revision it read", async () => {
    const { client, request } = clientAnswering(ok())
    await client.deleteAssistant("jeff", 3, "Jeff")
    expect(request).toHaveBeenLastCalledWith({ type: "assistant.delete", id: "jeff", rev: 3 })
  })

  it("saveDevice sends the target, revision and settings; a name and saveAnyway only when given", async () => {
    const { client, request } = clientAnswering(ok())
    const target = { kind: "device", id: "d1" } as const
    await client.saveDevice(target, 2, { interruptMode: "instant" })
    expect(request).toHaveBeenLastCalledWith({ type: "device.save", target, rev: 2, settings: { interruptMode: "instant" } })
    await client.saveDevice(target, 2, {}, { name: "Desk", saveAnyway: true, label: "Desk" })
    expect(request).toHaveBeenLastCalledWith({ type: "device.save", target, rev: 2, settings: {}, name: "Desk", saveAnyway: true })
  })

  it("a stale answer becomes a 'stale' outcome and tells the user once, by the entity's name", async () => {
    const { client, toasts } = clientAnswering(refused({ code: "stale", message: "changed" }))
    expect(await client.saveAssistant(exampleAssistant)).toEqual({ kind: "stale", message: "changed" })
    expect(toasts()).toEqual(["Jeff was changed somewhere else. Showing the latest version; your edits were not saved."])
    // The name given by the caller wins over the assistant's own (a rename in the draft).
    await client.saveAssistant(exampleAssistant, { name: "Jeffrey" })
    expect(toasts().at(-1)).toMatch(/^Jeffrey was changed/)
  })

  it("a stale delete or device save names what it can: the name, else the id, else 'The device'", async () => {
    const { client, toasts } = clientAnswering(refused({ code: "stale", message: "changed" }))
    await client.deleteAssistant("jeff", 1)
    expect(toasts().at(-1)).toMatch(/^jeff was changed/)
    await client.deleteAssistant("jeff", 1, "Jeff")
    expect(toasts().at(-1)).toMatch(/^Jeff was changed/)
    await client.saveDevice({ kind: "device", id: "d1" }, 1, {})
    expect(toasts().at(-1)).toMatch(/^The device was changed/)
    await client.saveDevice({ kind: "device", id: "d1" }, 1, {}, { label: "Desk" })
    expect(toasts().at(-1)).toMatch(/^Desk was changed/)
  })

  it("other outcomes (field errors, warnings, refusals) are returned without a toast", async () => {
    const errors: ReadonlyArray<NonNullable<ResultMessage["error"]>> = [
      { code: "invalid_settings", message: "x", fieldErrors: [{ key: "name", message: "Taken." }] },
      { code: "invalid_settings", message: "x", warnings: [{ key: null, message: "w" }] },
      { code: "locked", message: "Unlock." }
    ]
    for (const error of errors) {
      const { client, toasts } = clientAnswering(refused(error))
      const outcome = await client.saveAssistant(exampleAssistant)
      expect(outcome.kind).not.toBe("ok")
      expect(outcome.kind).not.toBe("stale")
      expect(toasts()).toEqual([])
    }
  })
})
