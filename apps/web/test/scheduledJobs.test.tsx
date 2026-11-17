import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ScheduledJobsPage } from "@/components/settings/pages/ScheduledJobsPage.tsx"
import type { VoiceApi } from "@/lib/voiceCatalog.ts"
import { createScheduledJobsMock } from "../mock/scheduledJobs.ts"

// P6 (docs/SCHEDULING.md): Diagnostics › Scheduled jobs lists the jobs from the admin API and cancels one; the mock
// server answers the same paths.

describe("the scheduled jobs page", () => {
  it("lists module, kind, label, state, due time and origin, and cancels a job", async () => {
    const mock = createScheduledJobsMock(() => Date.parse("2026-11-18T12:00:00Z"))
    const calls: Array<[string, string | undefined]> = []
    const api: VoiceApi = {
      request: async (path, init) => {
        calls.push([path, init?.method])
        const cancel = /^scheduler\/jobs\/(.+)\/cancel$/.exec(path)
        if (cancel !== null) {
          mock.cancel(decodeURIComponent(cancel[1]!))
          return new Response(JSON.stringify({ cancelled: true }), { status: 200 })
        }
        return new Response(JSON.stringify(mock.list()), { status: 200 })
      }
    }
    vi.spyOn(window, "confirm").mockReturnValue(true)
    await act(async () => void render(<ScheduledJobsPage api={api} />))
    expect(screen.getByTestId("scheduled-summary")).toHaveTextContent("5 scheduled")
    const rows = screen.getAllByTestId("scheduled-job")
    const pasta = rows.find((r) => r.textContent?.includes("Pasta"))!
    expect(pasta).toHaveTextContent("Timer")
    expect(pasta).toHaveTextContent("Timers")
    expect(pasta).toHaveTextContent("device kitchen-0001")
    expect(rows.find((r) => r.textContent?.includes("Wake up"))).toHaveTextContent("Waiting for its module to run")
    expect(rows.find((r) => r.textContent?.includes("Water the plants"))).toHaveTextContent("(removed)")
    expect(rows.find((r) => r.textContent?.includes("Turn off the oven"))).toHaveTextContent("Home Assistant did not answer")
    await act(async () => fireEvent.click(within(pasta).getByTestId("scheduled-cancel")))
    expect(calls).toContainEqual(["scheduler/jobs/job_pasta/cancel", "POST"])
    expect(screen.getByTestId("scheduled-summary")).toHaveTextContent("4 scheduled")
    const after = screen.getAllByTestId("scheduled-job").find((r) => r.textContent?.includes("Pasta"))!
    expect(after.getAttribute("data-state")).toBe("cancelled")
    expect(within(after).queryByTestId("scheduled-cancel")).toBeNull()
  })
})
