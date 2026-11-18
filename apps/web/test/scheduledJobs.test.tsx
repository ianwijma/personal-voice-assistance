import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ScheduledJobsPage } from "@/components/settings/pages/ScheduledJobsPage.tsx"
import type { VoiceApi } from "@/lib/voiceCatalog.ts"
import { ApiError } from "@/lib/voiceCatalog.ts"
import { createScheduledJobsMock, MockSchedulerError } from "../mock/scheduledJobs.ts"

// P6 (docs/SCHEDULING.md "Admin"): Diagnostics › Scheduled jobs reads the admin API a page at a time, loads further
// pages on request and cancels a job; the mock server answers the same paths the way the real server does.

const apiOn = (mock: ReturnType<typeof createScheduledJobsMock>, calls: Array<[string, string | undefined]> = []): VoiceApi => ({
  request: async (path, init) => {
    calls.push([path, init?.method])
    const cancel = /^scheduler\/jobs\/(.+)\/cancel$/.exec(path)
    if (cancel !== null) {
      if (!mock.cancel(decodeURIComponent(cancel[1]!))) throw new ApiError(404, "not_found", "There is no such live or failed job")
      return new Response(JSON.stringify({ cancelled: true }), { status: 200 })
    }
    const url = new URL(path, "http://x/")
    try {
      return new Response(JSON.stringify(mock.list(url.searchParams.get("cursor") ?? undefined)), { status: 200 })
    } catch (e) {
      if (e instanceof MockSchedulerError) throw new ApiError(e.status, e.code, e.message)
      throw e
    }
  }
})

describe("the scheduled jobs page", () => {
  it("lists handler, key, state, due time, repeat and origin; loads more pages; cancels a job", async () => {
    const mock = createScheduledJobsMock(() => Date.parse("2026-11-18T12:00:00Z"))
    const calls: Array<[string, string | undefined]> = []
    vi.spyOn(window, "confirm").mockReturnValue(true)
    await act(async () => void render(<ScheduledJobsPage api={apiOn(mock, calls)} />))
    expect(screen.getByTestId("scheduled-summary")).toHaveTextContent("5 scheduled")
    expect(screen.getByText(/does not interrupt it/)).toBeInTheDocument()
    let rows = screen.getAllByTestId("scheduled-job")
    // One page: 24 of the 36 jobs, live ones first by due time.
    expect(rows).toHaveLength(24)
    expect(rows.slice(0, 5).map((r) => r.getAttribute("data-state"))).toEqual(["running", "scheduled", "scheduled", "scheduled", "scheduled"])
    const pasta = rows.find((r) => r.textContent?.includes("timer:pasta"))!
    expect(pasta).toHaveTextContent("Timers")
    expect(pasta).toHaveTextContent("ring")
    expect(pasta).toHaveTextContent("device kitchen-0001")
    expect(rows.find((r) => r.textContent?.includes("Alarms"))).toHaveTextContent("repeats 45 6 * * 1-5 (Europe/Amsterdam)")
    expect(rows.find((r) => r.textContent?.includes("old-module"))).toHaveTextContent("(removed)")
    expect(rows.find((r) => r.textContent?.includes("Web search"))).toHaveTextContent("for sam")
    expect(rows.find((r) => r.textContent?.includes("run-command"))).toHaveTextContent("Home Assistant did not answer")
    // The next page, on request: the rest, and no further button.
    await act(async () => fireEvent.click(screen.getByTestId("scheduled-more")))
    rows = screen.getAllByTestId("scheduled-job")
    expect(rows).toHaveLength(36)
    expect(new Set(rows.map((r) => r.textContent)).size).toBe(36)
    expect(screen.queryByTestId("scheduled-more")).toBeNull()
    expect(calls.some(([p]) => p.startsWith("scheduler/jobs?cursor="))).toBe(true)
    // Cancel a running job: the question says it is not interrupted.
    const digest = rows.find((r) => r.textContent?.includes("digest"))!
    await act(async () => fireEvent.click(within(digest).getByTestId("scheduled-cancel")))
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringMatching(/not interrupted/))
    await act(async () => fireEvent.click(within(screen.getAllByTestId("scheduled-job").find((r) => r.textContent?.includes("timer:pasta"))!).getByTestId("scheduled-cancel")))
    expect(calls).toContainEqual(["scheduler/jobs/job_pasta/cancel", "POST"])
    expect(screen.getByTestId("scheduled-summary")).toHaveTextContent("3 scheduled")
  })

  it("a page the server no longer knows starts the list again from the top", async () => {
    const mock = createScheduledJobsMock(() => Date.parse("2026-11-18T12:00:00Z"))
    const api = apiOn(mock)
    await act(async () => void render(<ScheduledJobsPage api={api} />))
    // The mock forgets its cursors (as the server does past a few hundred), then Load more is pressed.
    const fresh = createScheduledJobsMock(() => Date.parse("2026-11-18T12:00:00Z"))
    Object.assign(mock, { list: fresh.list })
    await act(async () => fireEvent.click(screen.getByTestId("scheduled-more")))
    expect(screen.getByRole("alert")).toHaveTextContent("read again from the top")
    expect(screen.getAllByTestId("scheduled-job")).toHaveLength(24)
  })

  it("the mock answers like the server: pages with next, 400 for an unknown cursor or limit, 404 for a finished job", () => {
    const mock = createScheduledJobsMock(() => 0)
    const first = mock.list()
    expect(first.jobs).toHaveLength(24)
    expect(first.next).toBeDefined()
    const second = mock.list(first.next)
    expect(second.jobs).toHaveLength(12)
    expect(second.next).toBeUndefined()
    expect(() => mock.list("live.zz")).toThrow(MockSchedulerError)
    expect(() => mock.list(undefined, 25)).toThrow(MockSchedulerError)
    expect(mock.cancel("job_feed0")).toBe(false)
    expect(mock.cancel("job_oven")).toBe(true)
    expect(mock.cancel("job_oven")).toBe(false)
  })
})
