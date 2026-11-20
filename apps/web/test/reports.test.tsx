import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_REPORT_BODY_CHARS, REPORT_REPOSITORY } from "@pva/protocol"
import { ClientContext } from "@/components/context.tsx"
import { ReportsPage } from "@/components/settings/pages/ReportsPage.tsx"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import type { VoiceApi } from "@/lib/voiceCatalog.ts"
import { ApiError } from "@/lib/voiceCatalog.ts"
import { createReportsMock, FAILING_ID, MockReportError, REPORT_IDS } from "../mock/reports.ts"

// Diagnostics › Reports (docs/REPORTS.md): the list, a report's detail view with edit, save, send, the issue address
// filed by hand and delete, against the mock server's model (the routes answer as the real server's do).

type Call = readonly [path: string, method: string | undefined, body: unknown]

const apiOn = (mock: ReturnType<typeof createReportsMock>, calls: Array<Call> = []): VoiceApi => ({
  request: async (path, init) => {
    calls.push([path, init?.method, init?.body])
    const url = new URL(path, "http://x/")
    const one = /^\/reports\/([^/]+)(\/send)?$/.exec(url.pathname)
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
    try {
      if (one === null) {
        const limit = url.searchParams.get("limit")
        return json(mock.list(url.searchParams.get("cursor") ?? undefined, limit === null ? undefined : Number(limit)))
      }
      const id = decodeURIComponent(one[1]!)
      if (one[2] !== undefined) return json(mock.send(id))
      if (init?.method === "PUT") return json(mock.update(id, init.body as never))
      if (init?.method === "DELETE") return mock.remove(id), json({ removed: true })
      return json(mock.get(id))
    } catch (e) {
      if (e instanceof MockReportError) throw new ApiError(e.status, e.code, e.message)
      throw e
    }
  }
})

const mount = (api: VoiceApi, path: ReadonlyArray<string> = ["diagnostics", "reports"]) => {
  const store = createStore({ ...initialState, ui: { ...initialState.ui, settingsOpen: true, settingsPath: path } }, reducer)
  const settings = vi.fn()
  const client = { store, settings } as unknown as AssistantClient
  render(<ClientContext.Provider value={client}><ReportsPage api={api} /></ClientContext.Provider>)
  return { store, settings }
}
const detail = (api: VoiceApi, id: string) => mount(api, ["diagnostics", "reports", id])
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement
const body = () => screen.getByLabelText("Text (Markdown)") as HTMLTextAreaElement
const press = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }))
  })
}

afterEach(cleanup)

describe("Reports list", () => {
  it("shows each status, kind, where it was said and the issue link; a failed one shows its error", async () => {
    mount(apiOn(createReportsMock()))
    expect(await screen.findByTestId("reports")).toBeInTheDocument()
    const rows = screen.getAllByTestId("report")
    expect(rows[0]).toHaveTextContent("The timer rang twice in the kitchen")
    expect(rows[0]).toHaveTextContent("Draft")
    expect(rows[0]).toHaveTextContent("Problem")
    expect(rows[0]).toHaveTextContent("Kitchen · Jev")
    const failed = rows.find((r) => r.getAttribute("data-status") === "failed")!
    expect(within(failed).getByTestId("report-last-error")).toHaveTextContent("GitHub refused the token")
    const sent = rows.find((r) => r.textContent?.includes("noisy room"))!
    const link = within(sent).getByRole("link", { name: "Issue #42" })
    expect(link).toHaveAttribute("href", `https://github.com/${REPORT_REPOSITORY}/issues/42`)
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer noopener")
    expect(rows.find((r) => r.textContent?.includes("Let the assistant read recipes"))).toHaveTextContent("Feature idea")
    expect(screen.getByRole("link", { name: REPORT_REPOSITORY })).toHaveAttribute("href", `https://github.com/${REPORT_REPOSITORY}/issues`)
    expect(screen.getByTestId("reports-sending")).toHaveTextContent("New reports wait here until you send them")
  })

  it("says how a report is made when there are none", async () => {
    const mock = createReportsMock()
    for (const id of [REPORT_IDS.draftProblem, REPORT_IDS.draftFeature, REPORT_IDS.failed, REPORT_IDS.sent, ...Array.from({ length: 21 }, (_, i) => REPORT_IDS.old(i))]) mock.remove(id)
    mount(apiOn(mock))
    expect(await screen.findByTestId("reports-empty")).toHaveTextContent("report a problem")
    expect(screen.getByTestId("reports-empty")).toHaveTextContent("feature idea")
  })

  it("says when the server keeps no reports", async () => {
    mount(apiOn(createReportsMock({ available: false })))
    expect(await screen.findByTestId("no-reports")).toBeInTheDocument()
  })

  it("says where the token is set when there is none", async () => {
    mount(apiOn(createReportsMock({ hasToken: false })))
    expect(await screen.findByTestId("reports-sending")).toHaveTextContent(/No GitHub token is set.*by hand.*Modules › Reports\./)
  })

  it("loads more with the cursor and shows a report once", async () => {
    const calls: Array<Call> = []
    mount(apiOn(createReportsMock(), calls))
    await screen.findByTestId("reports")
    expect(screen.getAllByTestId("report")).toHaveLength(20)
    await press("Load more")
    expect(screen.getAllByTestId("report")).toHaveLength(25)
    expect(screen.queryByTestId("reports-more")).toBeNull()
    expect(calls).toHaveLength(2)
    expect(calls[1]![0]).toMatch(/^reports\?cursor=\d+-r[0-9a-f]{16}$/)
  })

  it("opens a report at its own path", async () => {
    const { settings } = mount(apiOn(createReportsMock()))
    await screen.findByTestId("reports")
    fireEvent.click(screen.getAllByTestId("report-open")[0]!)
    expect(settings).toHaveBeenCalledWith(["diagnostics", "reports", REPORT_IDS.draftProblem])
  })

  it("shows the problem when the list cannot be read", async () => {
    mount({ request: async () => { throw new ApiError(0, "network", "The assistant could not be reached.") } })
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be reached")
  })
})

describe("Report detail", () => {
  it("shows the public notice, edits, and saves only the changed fields", async () => {
    const calls: Array<Call> = []
    const store = detail(apiOn(createReportsMock(), calls), REPORT_IDS.draftProblem).store
    await screen.findByTestId("report-detail")
    expect(screen.getByTestId("report-public-notice")).toHaveTextContent("public")
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()
    fireEvent.change(field("Title"), { target: { value: "The timer rang three times" } })
    expect(save).toBeEnabled()
    expect(store.get().ui.settingsDirty).toBe(true)
    await press("Save")
    expect(calls.filter((c) => c[1] === "PUT")).toEqual([[`reports/${REPORT_IDS.draftProblem}`, "PUT", { title: "The timer rang three times" }]])
    expect(screen.getByTestId("report-notice")).toHaveTextContent("Saved")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(store.get().ui.settingsDirty).toBe(false)
    fireEvent.change(body(), { target: { value: "New text" } })
    await press("Save")
    expect(calls.filter((c) => c[1] === "PUT")[1]).toEqual([`reports/${REPORT_IDS.draftProblem}`, "PUT", { body: "New text" }])
  })

  it("counts characters near the limit", async () => {
    detail(apiOn(createReportsMock()), REPORT_IDS.draftProblem)
    await screen.findByTestId("report-detail")
    expect(screen.queryByTestId("report-count")).toBeNull()
    fireEvent.change(body(), { target: { value: "x".repeat(MAX_REPORT_BODY_CHARS - 10) } })
    expect(screen.getByTestId("report-count")).toHaveTextContent(`${MAX_REPORT_BODY_CHARS - 10} of ${MAX_REPORT_BODY_CHARS}`)
  })

  it("saves pending edits, then sends, and shows the issue", async () => {
    const calls: Array<Call> = []
    detail(apiOn(createReportsMock(), calls), REPORT_IDS.draftFeature)
    await screen.findByTestId("report-detail")
    fireEvent.change(field("Title"), { target: { value: "Read recipes aloud" } })
    await press("Send to GitHub")
    expect(calls.filter((c) => c[1] !== undefined).map((c) => [c[0], c[1]])).toEqual([[`reports/${REPORT_IDS.draftFeature}`, "PUT"], [`reports/${REPORT_IDS.draftFeature}/send`, "POST"]])
    expect(screen.getByTestId("report-status")).toHaveTextContent("Sent")
    expect(screen.getByRole("link", { name: /^Issue #\d+$/ })).toHaveAttribute("target", "_blank")
    expect(field("Title")).toHaveAttribute("readonly")
    expect(screen.queryByRole("button", { name: "Send to GitHub" })).toBeNull()
  })

  it("cannot be sent twice while it is on its way", async () => {
    const mock = createReportsMock()
    const inner = apiOn(mock)
    let release: () => void = () => {}
    const calls: Array<string> = []
    detail({
      request: async (path, init) => {
        if (path.endsWith("/send")) {
          calls.push(path)
          await new Promise<void>((r) => (release = r))
        }
        return inner.request(path, init)
      }
    }, REPORT_IDS.draftFeature)
    await screen.findByTestId("report-detail")
    const send = screen.getByRole("button", { name: "Send to GitHub" })
    fireEvent.click(send)
    fireEvent.click(send)
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(send).toBeDisabled()
    await act(async () => release())
    expect(calls).toHaveLength(1)
    await waitFor(() => expect(screen.getByTestId("report-status")).toHaveTextContent("Sent"))
  })

  it("shows why sending failed", async () => {
    detail(apiOn(createReportsMock()), FAILING_ID)
    await screen.findByTestId("report-detail")
    expect(screen.getByTestId("report-last-error")).toHaveTextContent("refused the token")
    await press("Send to GitHub")
    expect(screen.getByTestId("report-status")).toHaveTextContent("Failed")
    expect(screen.getByTestId("report-last-error")).toHaveTextContent("GitHub refused the token (401)")
    expect(screen.getByRole("button", { name: "Send to GitHub" })).toBeEnabled()
  })

  it("offers no send without a token, only the GitHub link", async () => {
    detail(apiOn(createReportsMock({ hasToken: false })), REPORT_IDS.draftProblem)
    await screen.findByTestId("report-detail")
    expect(screen.queryByRole("button", { name: "Send to GitHub" })).toBeNull()
    const link = screen.getByRole("link", { name: "Open on GitHub" })
    expect(link.getAttribute("href")).toMatch(/^https:\/\/github\.com\/.+\/issues\/new\?title=/)
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer noopener")
    expect(screen.queryByTestId("report-shortened")).toBeNull()
  })

  it("offers to copy the full text when the link had to shorten it", async () => {
    const mock = createReportsMock()
    mock.update(REPORT_IDS.draftProblem, { body: "y".repeat(5000) })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    detail(apiOn(mock), REPORT_IDS.draftProblem)
    await screen.findByTestId("report-detail")
    expect(screen.getByTestId("report-shortened")).toHaveTextContent("shortened")
    await press("Copy full text")
    expect(writeText).toHaveBeenCalledWith("y".repeat(5000))
  })

  it("records an issue filed by hand, and refuses an address of another repository", async () => {
    const calls: Array<Call> = []
    detail(apiOn(createReportsMock(), calls), REPORT_IDS.draftProblem)
    await screen.findByTestId("report-detail")
    const input = screen.getByLabelText("Filed it by hand? Paste the issue address")
    for (const bad of ["https://github.com/someone/else/issues/3", `https://github.com/${REPORT_REPOSITORY}/issues/12345678901`]) {
      fireEvent.change(input, { target: { value: bad } })
      await press("Save address")
      expect(screen.getByTestId("report-address-error")).toHaveTextContent(REPORT_REPOSITORY)
    }
    expect(calls.filter((c) => c[1] === "PUT")).toHaveLength(0)
    fireEvent.change(input, { target: { value: ` https://github.com/${REPORT_REPOSITORY}/issues/77 ` } })
    await press("Save address")
    expect(calls.filter((c) => c[1] === "PUT")).toEqual([[`reports/${REPORT_IDS.draftProblem}`, "PUT", { issueUrl: `https://github.com/${REPORT_REPOSITORY}/issues/77` }]])
    expect(screen.getByTestId("report-status")).toHaveTextContent("Sent")
    expect(screen.getByRole("link", { name: "Issue #77" })).toBeInTheDocument()
  })

  it("deletes after confirmation, and goes back to the list", async () => {
    const calls: Array<Call> = []
    const { settings } = detail(apiOn(createReportsMock(), calls), REPORT_IDS.draftProblem)
    await screen.findByTestId("report-detail")
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true)
    await press("Delete")
    expect(calls.some((c) => c[1] === "DELETE")).toBe(false)
    await press("Delete")
    expect(confirm.mock.calls[1]![0]).toContain("stays on GitHub")
    expect(calls.filter((c) => c[1] === "DELETE")).toHaveLength(1)
    expect(settings).toHaveBeenCalledWith(["diagnostics", "reports"])
    confirm.mockRestore()
  })

  it("is read-only once sent", async () => {
    detail(apiOn(createReportsMock()), REPORT_IDS.sent)
    await screen.findByTestId("report-detail")
    expect(field("Title")).toHaveAttribute("readonly")
    expect(body()).toHaveAttribute("readonly")
    for (const name of ["Save", "Send to GitHub", "Save address"]) expect(screen.queryByRole("button", { name })).toBeNull()
    expect(screen.queryByTestId("report-public-notice")).toBeNull()
    expect(screen.getByRole("link", { name: "Issue #42" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument()
  })

  it("says in words when the report is gone or was sent elsewhere", async () => {
    const mock = createReportsMock()
    const inner = apiOn(mock)
    detail(inner, "nope")
    expect(await screen.findByTestId("report-error")).toHaveTextContent("gone")
    cleanup()
    detail({
      request: async (path, init) => {
        if (path.endsWith("/send")) {
          mock.send(REPORT_IDS.draftFeature)
          throw new ApiError(409, "already_sent", "x")
        }
        return inner.request(path, init)
      }
    }, REPORT_IDS.draftFeature)
    await screen.findByTestId("report-detail")
    await press("Send to GitHub")
    expect(screen.getByTestId("report-error")).toHaveTextContent("sent already")
    expect(screen.getByTestId("report-status")).toHaveTextContent("Sent")
  })

  it("being sent from another tab: says so in its own words, and keeps the edits on the page", async () => {
    const inner = apiOn(createReportsMock())
    detail({
      request: async (path, init) => {
        if (path.endsWith("/send")) throw new ApiError(409, "sending", "This report is being sent")
        return inner.request(path, init)
      }
    }, REPORT_IDS.draftFeature)
    await screen.findByTestId("report-detail")
    await press("Send to GitHub")
    expect(screen.getByTestId("report-error")).toHaveTextContent("being sent right now, from another tab")
    expect(screen.getByTestId("report-error")).not.toHaveTextContent("sent already")
    expect(screen.getByTestId("report-status")).toHaveTextContent("Draft")
  })

  it("sent elsewhere while edits were open: shows the report as sent and says the edits were replaced", async () => {
    const mock = createReportsMock()
    const inner = apiOn(mock)
    detail({
      request: async (path, init) => {
        if (init?.method === "PUT") {
          mock.send(REPORT_IDS.draftFeature)
          throw new ApiError(409, "already_sent", "x")
        }
        return inner.request(path, init)
      }
    }, REPORT_IDS.draftFeature)
    await screen.findByTestId("report-detail")
    fireEvent.change(field("Title"), { target: { value: "My edit" } })
    await press("Save")
    expect(screen.getByTestId("report-error")).toHaveTextContent("Your unsaved edits were replaced")
    expect(screen.getByTestId("report-status")).toHaveTextContent("Sent")
  })

  it("shows a send whose result was never recorded legibly", async () => {
    const mock = createReportsMock()
    const inner = apiOn(mock)
    const maybe = "A send was started but its result was not recorded (the server stopped, or the answer was lost): the issue may have been filed. Look at the repository's issues before sending again, and record its address if it is there."
    detail({
      request: async (path, init) => {
        const r = await inner.request(path, init)
        if (path === `reports/${REPORT_IDS.draftProblem}`) return new Response(JSON.stringify({ ...(await r.json()), status: "failed", lastError: maybe }), { status: 200 })
        return r
      }
    }, REPORT_IDS.draftProblem)
    await screen.findByTestId("report-detail")
    expect(screen.getByTestId("report-last-error")).toHaveTextContent("The last attempt to send it did not work. A send was started")
    expect(screen.getByTestId("report-last-error")).toHaveTextContent("may have been filed")
  })

  it("says when the server cannot read its reports", async () => {
    detail(apiOn(createReportsMock({ available: false })), REPORT_IDS.draftProblem)
    expect(await screen.findByTestId("report-error")).toHaveTextContent("cannot read its reports")
  })

  it("says in words when there is no token or the network fails", async () => {
    const mock = createReportsMock()
    const inner = apiOn(mock)
    detail({
      request: async (path, init) => {
        if (path.endsWith("/send")) throw new ApiError(400, "no_token", "x")
        if (init?.method === "PUT") throw new ApiError(0, "network", "The assistant could not be reached.")
        return inner.request(path, init)
      }
    }, REPORT_IDS.draftFeature)
    await screen.findByTestId("report-detail")
    await press("Send to GitHub")
    expect(screen.getByTestId("report-error")).toHaveTextContent("No GitHub token is set")
    fireEvent.change(field("Title"), { target: { value: "Changed" } })
    await press("Save")
    expect(screen.getByTestId("report-error")).toHaveTextContent("could not be reached")
    expect(field("Title").value).toBe("Changed")
  })
})
