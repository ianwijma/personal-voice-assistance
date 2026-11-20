import type { ModuleInfo } from "@pva/protocol"
import { exampleUnavailableModule } from "@pva/protocol/examples"
import { describe, expect, it } from "vitest"
import { blankAssistantBody } from "../src/lib/assistants.ts"
import { createAssistantsMock } from "../mock/assistants.ts"
import { type CapabilityParts, reconcileCapability } from "../mock/capabilities.ts"

// Review round 5 (p1-r5c finding 3): the mock's capability reconciliation keeps a module that is unavailable for an
// unmet requirement unavailable, whoever has it on. The `health` scenario seeds Music (yt-dlp missing) and reconciles
// at start-up; the owner then creates the DJ assistant from Music's template, which switches Music on.
describe("mock capabilities: an unavailable module stays unavailable", () => {
  const parts: CapabilityParts = { forced: () => undefined, runningStatus: (_id, m) => m.status, runningTools: () => [], instanceStatus: () => undefined }

  it("the health scenario's Music at start-up, and after the DJ template is chosen", () => {
    // What the mock server's `health` scenario seeds, and how it reconciles (resetState, assistantsChanged).
    let modules: Array<ModuleInfo> = [structuredClone(exampleUnavailableModule)]
    const assistants = createAssistantsMock({ modules: () => modules, toolNames: () => [], checkOwn: () => [], accountProblem: () => undefined })
    const sync = () => {
      modules = modules.map((m) => (m.kind === "capability" ? reconcileCapability(m, assistants.assistants(), parts) : m))
    }
    assistants.reset()
    sync()
    const atStart = modules.find((m) => m.id === "music")!
    expect(atStart.state).toBe("unavailable")
    expect(atStart.unavailable?.reason).toBe("yt-dlp is missing")
    expect(atStart.instances ?? []).toEqual([])

    // The new-assistant wizard, started from the DJ template: its prompt, Music on.
    const dj = exampleUnavailableModule.templates!.find((t) => t.id === "music.dj")!
    const created = assistants.create({ assistant: { ...blankAssistantBody(dj.name), prompt: dj.prompt, modules: { music: { on: true, offTools: [] } } } }, [])
    expect(created.ok).toBe(true)
    sync()
    const after = modules.find((m) => m.id === "music")!
    expect(after.enabled).toBe(true)
    expect(after.state).toBe("unavailable")
    expect(after.unavailable?.reason).toBe("yt-dlp is missing")
    expect(after.instances ?? []).toEqual([])
    expect(after.tools).toEqual([])
  })
})
