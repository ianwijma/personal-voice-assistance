import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { MAX_SCHEDULED_JOBS_PAGE } from "@pva/protocol"
import { ScheduledJobsPage } from "@/components/settings/pages/ScheduledJobsPage.tsx"
import type { VoiceApi } from "@/lib/voiceCatalog.ts"
import { ApiError } from "@/lib/voiceCatalog.ts"
import { createScheduledJobsMock, MockSchedulerError } from "../mock/scheduledJobs.ts"

// P6 (docs/SCHEDULING.md "Admin"): Diagnostics › Scheduled jobs reads the admin API a page at a time, loads further
// pages on request and cancels a job; the mock server answers the same paths the way the real server does.

/** The page's API over the mock, as the mock server's routes answer (`cursor` and `limit` passed on, errors as statuses). */
const apiOn = (mock: ReturnType<typeof createScheduledJobsMock>, calls: Array<[string, string | undefined]> = []): VoiceApi => ({
  request: async (path, init) => {
    calls.push([path, init?.method])
    const cancel = /^scheduler\/jobs\/(.+)\/cancel$/.exec(path)
    if (cancel !== null) {
      if (!mock.cancel(decodeURIComponent(cancel[1]!))) throw new ApiError(404, "not_found", "There is no such live or failed job")
      return new Response(JSON.stringify({ cancelled: true }), { status: 200 })
    }
    const url = new URL(path, "http://x/")
    const limit = url.searchParams.get("limit")
    try {
      return new Response(JSON.stringify(mock.list(url.searchParams.get("cursor") ?? undefined, limit === null ? undefined : Number(limit))), { status: 200 })
    } catch (e) {
      if (e instanceof MockSchedulerError) throw new ApiError(e.status, e.code, e.message)
      throw e
    }
  }
})

/** An API whose answers wait until the test lets each one through, in any order. */
const heldApi = (inner: VoiceApi) => {
  const held: Array<{ readonly path: string; readonly release: () => void; readonly fail: (e: unknown) => void }> = []
  const api: VoiceApi = {
    request: (path, init) =>
      new Promise((resolve, reject) => {
        held.push({ path, release: () => void inner.request(path, init).then(resolve, reject), fail: reject })
      })
  }
  return { api, held }
}

const clock = () => Date.parse("2026-11-18T12:00:00Z")
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

describe("the scheduled jobs page", () => {
  it("lists handler, key, state, due time, repeat and origin; loads more pages; cancels a job", async () => {
    const mock = createScheduledJobsMock(clock)
    const calls: Array<[string, string | undefined]> = []
    vi.spyOn(window, "confirm").mockReturnValue(true)
    await act(async () => void render(<ScheduledJobsPage api={apiOn(mock, calls)} />))
    expect(screen.getByTestId("scheduled-summary")).toHaveTextContent("5 scheduled")
    expect(screen.getByText(/does not interrupt it/)).toBeInTheDocument()
    let rows = screen.getAllByTestId("scheduled-job")
    // One page of the 36 jobs, live ones first by due time.
    expect(rows).toHaveLength(MAX_SCHEDULED_JOBS_PAGE)
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
    const mock = createScheduledJobsMock(clock)
    await act(async () => void render(<ScheduledJobsPage api={apiOn(mock)} />))
    // The mock gives out 256 newer cursors (as other admin pages would): the page's own is forgotten.
    for (let i = 0; i < 256; i++) mock.list(undefined, 1)
    await act(async () => fireEvent.click(screen.getByTestId("scheduled-more")))
    expect(screen.getByRole("alert")).toHaveTextContent("read again from the top")
    expect(screen.getAllByTestId("scheduled-job")).toHaveLength(MAX_SCHEDULED_JOBS_PAGE)
  })

  it("a failed reload after a forgotten page is shown as the failure, not as a fresh list", async () => {
    const mock = createScheduledJobsMock(clock)
    const ok = apiOn(mock)
    let down = false
    const api: VoiceApi = {
      request: async (path, init) => {
        if (down && path === "scheduler/jobs") throw new ApiError(503, "unavailable", "The household store is busy")
        return ok.request(path, init)
      }
    }
    await act(async () => void render(<ScheduledJobsPage api={api} />))
    for (let i = 0; i < 256; i++) mock.list(undefined, 1)
    down = true
    await act(async () => fireEvent.click(screen.getByTestId("scheduled-more")))
    expect(screen.getByRole("alert")).toHaveTextContent("The household store is busy")
    expect(screen.getByRole("alert")).not.toHaveTextContent("read again from the top")
  })

  for (const how of ["Refresh", "the reload after a cancel"] as const) {
    it(`a Load more still on its way when ${how} starts a new reading is dropped (pages of two readings are never joined)`, async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true)
      const mock = createScheduledJobsMock(clock)
      const { api, held } = heldApi(apiOn(mock))
      await act(async () => void render(<ScheduledJobsPage api={api} />))
      held.shift()!.release()
      await flush()
      expect(screen.getAllByTestId("scheduled-job")).toHaveLength(MAX_SCHEDULED_JOBS_PAGE)
      // Load more is pressed; its answer is held back.
      await act(async () => fireEvent.click(screen.getByTestId("scheduled-more")))
      const more = held.shift()!
      expect(more.path).toMatch(/^scheduler\/jobs\?cursor=/)
      if (how === "Refresh") await act(async () => fireEvent.click(screen.getByText("Refresh")))
      else {
        const first = screen.getAllByTestId("scheduled-job").find((r) => r.textContent?.includes("timer:pasta"))!
        await act(async () => fireEvent.click(within(first).getByTestId("scheduled-cancel")))
        held.shift()!.release()
        await flush()
      }
      const reload = held.shift()!
      expect(reload.path).toBe("scheduler/jobs")
      reload.release()
      await flush()
      // The old reading's page arrives last: dropped. The list is the new first page, and Load more reads its next.
      more.release()
      await flush()
      const rows = screen.getAllByTestId("scheduled-job")
      expect(rows).toHaveLength(MAX_SCHEDULED_JOBS_PAGE)
      expect(rows.map((r) => r.getAttribute("data-state")).filter((x) => x === "done").length).toBeLessThan(MAX_SCHEDULED_JOBS_PAGE)
      await act(async () => fireEvent.click(screen.getByTestId("scheduled-more")))
      held.shift()!.release()
      await flush()
      const all = screen.getAllByTestId("scheduled-job")
      expect(new Set(all.map((r) => r.textContent)).size).toBe(all.length)
      expect(all).toHaveLength(36)
    })
  }

  it("the mock answers like the server: pages with next, 400 for an unknown cursor or limit, and cancel only for a live or failed job", () => {
    const mock = createScheduledJobsMock(() => 0)
    const first = mock.list()
    expect(first.jobs).toHaveLength(MAX_SCHEDULED_JOBS_PAGE)
    expect(first.next).toMatch(/^(live|finished)\.[0-9a-f]{32}$/)
    const second = mock.list(first.next)
    expect(second.jobs).toHaveLength(36 - MAX_SCHEDULED_JOBS_PAGE)
    expect(second.next).toBeUndefined()
    const refused = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        return e instanceof MockSchedulerError ? [e.status, e.code] : ["not a MockSchedulerError"]
      }
      return ["no error"]
    }
    expect(refused(() => mock.list("live.zz"))).toEqual([400, "invalid"])
    expect(refused(() => mock.list(undefined, MAX_SCHEDULED_JOBS_PAGE + 1))).toEqual([400, "invalid"])
    expect(refused(() => mock.list(undefined, 0))).toEqual([400, "invalid"])
    // A token of another mock (a restart) is unknown here.
    expect(refused(() => createScheduledJobsMock(() => 0).list(first.next))).toEqual([400, "invalid"])
    // The mock's cancel answers false (its route then 404) for a finished job; true once for a failed one.
    expect(mock.cancel("job_feed0")).toBe(false)
    expect(mock.cancel("job_oven")).toBe(true)
    expect(mock.cancel("job_oven")).toBe(false)
  })

  it("the mock's cursor keeps its place: a job of the page that is cancelled meanwhile does not move it; the 256 newest are kept", () => {
    const mock = createScheduledJobsMock(() => 0)
    const live = ["job_digest", "job_pasta", "job_news", "job_alarm", "job_gone"]
    const two = mock.list(undefined, 2)
    expect(two.jobs.map((j) => j.id)).toEqual(live.slice(0, 2))
    // The cursor's job finishes: the list goes on with the next live jobs, as the server's (not into the finished ones).
    expect(mock.cancel("job_pasta")).toBe(true)
    expect(mock.list(two.next, 2).jobs.map((j) => j.id)).toEqual(live.slice(2, 4))
    // Eviction: after 256 newer cursors the oldest is unknown; the 256th newest still works.
    const oldest = mock.list(undefined, 1).next!
    const kept = mock.list(undefined, 1).next!
    for (let i = 0; i < 255; i++) mock.list(undefined, 1)
    expect(() => mock.list(oldest)).toThrow(MockSchedulerError)
    expect(mock.list(kept, 1).jobs).toHaveLength(1)
  })
})
