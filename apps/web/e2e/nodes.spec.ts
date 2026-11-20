import { type Page } from "@playwright/test"
import { exampleNodePairing } from "@pva/protocol/examples"
import { expect, loginAdmin, mock, test } from "./fixtures.ts"

// Admin › Devices › Voice nodes (docs/VOICE-NODES.md §7, protocol 12), on the mock's `nodes` scenarios: Add voice node
// (address → one-time code and install command → paired → its page), the node page's Status, Actions, Sound and
// Sound devices, the sections a display-less device does not have, the "answers everything" warning, Remove, and no
// sideways scroll on a 320 px phone. Mock data (`nodes`): Kitchen speaker (online, up to date, wss), Living room (online,
// Update pending, ws, a microphone that is not connected, volume 60), Garage (offline, arecord missing, a last error);
// Every voice node has Jeff "Hey Jeff" and T3 "Hey T3".

const KITCHEN = "vn-kitchen-speaker01"
const LIVING = "vn-living-room-nuc2"
const GARAGE = "vn-garage-pi-zero03"
const HEX = exampleNodePairing.tlsPin!.slice("sha256:".length)
const B64 = Buffer.from(HEX, "hex").toString("base64")

const sent = async <T extends Record<string, unknown>>(type: string) => (await mock.log()).messages.filter((m) => m.type === type) as unknown as Array<T>
const save = (page: Page) => page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true })
/** A range input as a drag would set it (React listens to `input`). */
const setRange = (page: Page, testId: string, value: number) =>
  page.getByTestId(testId).evaluate((el, v) => {
    const input = el as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v))
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }, value)
const dialog = (page: Page) => page.getByTestId("add-node")
const noSidewaysScroll = async (page: Page) => {
  const wide = await page.evaluate(() => {
    const over = [...document.querySelectorAll<HTMLElement>("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible" && getComputedStyle(el).overflowX !== "hidden" && !el.matches("pre, table, [class*=overflow-x-auto]"))
    return { doc: document.documentElement.scrollWidth - window.innerWidth, over: over.map((el) => el.dataset.testid ?? el.tagName) }
  })
  expect(wide.doc).toBeLessThanOrEqual(0)
  expect(wide.over).toEqual([])
}

test.beforeEach(async () => {
  await mock.scenario("nodes")
})

test("add a voice node: the empty state, address, code and command, paired, its page; Every voice node is seeded from Every browser", async ({ page, baseURL }) => {
  await mock.scenario("nodes-empty")
  await loginAdmin(page, baseURL, "#settings/devices")
  const section = page.getByTestId("device-type-voice-node")
  await expect(section.getByTestId("no-devices")).toContainText("No voice nodes yet. Add one: you get a command to run on the box.")
  await expect(section.locator("[data-device='type:voice-node']")).toContainText("No assistant: nobody answers")
  await section.getByTestId("add-node-button").click()

  // 1. Name and address: prefilled with the page's own server (here the mock, on 127.0.0.1: a warning).
  await expect(dialog(page).getByTestId("add-node-address")).toBeVisible()
  await expect(page.locator("#node-server")).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+$/)
  await expect(page.getByTestId("address-loopback")).toContainText("127.0.0.1 is the box itself")
  await expect(page.getByTestId("address-plain")).toContainText("unencrypted")
  await page.locator("#node-server").fill("assistant.home")
  await expect(dialog(page)).toContainText("Start with http:// or https://.")
  await expect(page.getByTestId("get-code")).toBeDisabled()
  await page.locator("#node-server").fill("http://192.168.1.20:8787/admin/")
  await expect(page.getByTestId("address-loopback")).toBeHidden()
  await page.locator("#node-name").fill("Study")
  await page.getByTestId("get-code").click()

  // 2. The code, a countdown, the command with it, waiting.
  await expect(page.getByTestId("pair-code")).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  const code = (await page.getByTestId("pair-code").textContent())!.replace("-", "")
  await expect(page.getByTestId("pair-countdown")).toHaveText(/^Expires in (10:00|9:\d\d)$/)
  await expect(page.getByTestId("install-command")).toHaveText(`curl -fsSL http://192.168.1.20:8787/node/install.sh | sudo sh -s -- --server http://192.168.1.20:8787 --code ${code}`)
  await expect(page.getByTestId("pair-waiting")).toContainText("Waiting for the node…")
  expect(await sent("node.pair.create")).toEqual([expect.objectContaining({ name: "Study" })])
  // The first code seeded Every voice node from Every browser: its assistants, without follow-up values.
  await expect(section.locator("[data-device='type:voice-node']")).toContainText("T3 · “Hey T3” +1")

  // 3. The mock's box redeems the code after 2 s: paired, then its page.
  await expect(dialog(page).getByTestId("add-node-paired")).toContainText("Study is paired.", { timeout: 6000 })
  await expect(section.getByTestId("type-count")).toHaveText("1 voice node")
  await page.getByTestId("open-node").click()
  await expect(dialog(page)).toBeHidden()
  await expect(page.getByTestId("page-title")).toHaveText("Study")
  await expect(page.getByTestId("node-status")).toContainText("Online")
  await expect(page.getByTestId("node-version")).toContainText("up to date")
  expect(await sent("node.pair.cancel")).toEqual([])
})

test("the code: Cancel cancels it, an expired one offers a new one, Add another starts again", async ({ page, baseURL }) => {
  await mock.nodes({ redeemAfterMs: 0 })
  await loginAdmin(page, baseURL, "#settings/devices")
  await page.getByTestId("add-node-button").click()
  await page.locator("#node-server").fill("http://192.168.1.20:8787")
  await page.getByTestId("get-code").click()
  const code = (await page.getByTestId("pair-code").textContent())!.replace("-", "")
  await page.getByTestId("cancel-pairing").click()
  await expect(dialog(page)).toBeHidden()
  await expect.poll(async () => (await sent<{ code: string }>("node.pair.cancel")).map((m) => m.code)).toEqual([code])

  // Escape closes it too, and cancels.
  await page.getByTestId("add-node-button").click()
  await page.locator("#node-server").fill("http://192.168.1.20:8787")
  await page.getByTestId("get-code").click()
  await expect(page.getByTestId("pair-code")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toBeHidden()
  await expect.poll(async () => (await sent("node.pair.cancel")).length).toBe(2)

  await mock.nodes({ ttlMs: 1500 })
  await page.getByTestId("add-node-button").click()
  await page.locator("#node-server").fill("http://192.168.1.20:8787")
  await page.getByTestId("get-code").click()
  await expect(page.getByTestId("pair-expired")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("pair-countdown")).toHaveText("The code expired.")
  await expect(page.getByTestId("install-command")).toBeHidden()
  await mock.nodes({ ttlMs: 600_000 })
  await page.getByTestId("new-code").click()
  await expect(page.getByTestId("install-command")).toBeVisible()
  await mock.redeem()
  await expect(page.getByTestId("add-node-paired")).toContainText("raspberrypi is paired.")
  await page.getByTestId("add-another").click()
  await expect(page.getByTestId("add-node-address")).toBeVisible()
  await expect(page.locator("#node-name")).toHaveValue("")
})

test("https: the server's pin goes into the command; an http address to an https server is flagged; a proxy's pin can be pasted", async ({ page, baseURL }) => {
  await mock.nodes({ tls: true, tlsPin: exampleNodePairing.tlsPin!, redeemAfterMs: 0 })
  await loginAdmin(page, baseURL, "#settings/devices")
  await page.getByTestId("add-node-button").click()
  await page.locator("#node-server").fill("https://assistant.home:8443")
  await page.getByTestId("get-code").click()
  const code = (await page.getByTestId("pair-code").textContent())!.replace("-", "")
  await expect(page.getByTestId("install-command")).toHaveText(
    `curl -fsSL -k --pinnedpubkey 'sha256//${B64}' https://assistant.home:8443/node/install.sh | sudo sh -s -- --server https://assistant.home:8443 --tls-pin sha256:${HEX} --code ${code}`
  )
  await expect(page.getByTestId("pin-field")).toBeHidden()
  // Change the address: the same code, the command follows.
  await page.getByTestId("change-address").click()
  await page.locator("#node-server").fill("http://192.168.1.20:8787")
  await expect(page.getByTestId("get-code")).toHaveText("Back to the code")
  await page.getByTestId("get-code").click()
  await expect(page.getByTestId("pair-code")).toHaveText(`${code.slice(0, 4)}-${code.slice(4)}`)
  await expect(page.getByTestId("pair-https")).toContainText("This server serves https")
  expect(await sent("node.pair.create")).toHaveLength(1)
  await page.getByTestId("cancel-pairing").click()

  // TLS from a proxy: the server knows no pin; a pasted one adds -k and the pin.
  await mock.nodes({ tls: false, tlsPin: null })
  await page.getByTestId("add-node-button").click()
  await page.locator("#node-server").fill("https://assistant.example.org")
  await page.getByTestId("get-code").click()
  await expect(page.getByTestId("install-command")).not.toContainText("pinnedpubkey")
  await page.getByTestId("pin-field").locator("summary").click()
  await page.locator("#node-pin").fill("sha256:1234")
  await expect(page.getByTestId("pin-field")).toContainText("This is not a SHA-256 pin.")
  await page.locator("#node-pin").fill(`sha256//${B64}`)
  await expect(page.getByTestId("install-command")).toContainText(`--pinnedpubkey 'sha256//${B64}'`)
  await expect(page.getByTestId("install-command")).toContainText(`--tls-pin sha256:${HEX}`)
})

test("a server without the node program says how to build it; one on a loopback address says nodes cannot reach it", async ({ page, baseURL }) => {
  await mock.nodes({ built: false, loopbackOnly: true })
  await loginAdmin(page, baseURL, "#settings/devices")
  await page.getByTestId("add-node-button").click()
  await page.locator("#node-server").fill("http://192.168.1.20:8787")
  await page.getByTestId("get-code").click()
  await expect(page.getByTestId("pair-not-built")).toContainText("pnpm --filter @pva/node bundle")
  await expect(page.getByTestId("install-command")).toBeHidden()
  await expect(page.getByTestId("pair-loopback")).toContainText("SERVE_HOST=0.0.0.0")
})

test("the list and a node's page: status, Actions send node.command.send, offline disables them", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/devices")
  const section = page.getByTestId("device-type-voice-node")
  await expect(section.getByTestId("type-count")).toHaveText("3 voice nodes")
  const living = section.locator(`[data-device=${LIVING}]`)
  await expect(living.getByTestId("update-pending")).toBeVisible()
  await expect(living.getByTestId("unencrypted")).toBeVisible()
  await expect(living.getByTestId("device-meta")).toContainText("Online")
  const garage = section.locator(`[data-device=${GARAGE}]`)
  await expect(garage.getByTestId("device-meta")).toContainText("Offline since")
  await expect(garage.getByTestId("device-last-error")).toContainText("arecord is not installed")
  await expect(section.locator(`[data-device=${KITCHEN}]`).getByTestId("update-pending")).toHaveCount(0)

  await living.click()
  const status = page.getByTestId("node-status")
  await expect(status.getByTestId("node-version")).toContainText("Update pending")
  await expect(status.getByTestId("node-platform")).toContainText("Intel NUC7i3BNH · Linux x64 · host living-room-nuc")
  await expect(status.getByTestId("node-audio")).toContainText("PipeWire")
  await expect(status.getByTestId("node-audio")).toContainText("Microphone: Jabra SPEAK 510 · 16 kHz")
  await expect(status.getByTestId("node-transport")).toContainText("Unencrypted")
  await expect(status.getByTestId("node-can")).toHaveText("Speaks, listens; no screen")
  const actions = page.getByTestId("node-actions")
  for (const command of ["identify", "test-speaker", "update"] as const) {
    await actions.getByTestId(`node-${command}`).click()
    await expect(actions.getByTestId("node-said")).toContainText("Sent.")
  }
  expect((await sent<{ id: string; command: string }>("node.command.send")).map((m) => [m.id, m.command])).toEqual([[LIVING, "identify"], [LIVING, "test-speaker"], [LIVING, "update"]])
  // The mock's box updates itself: Update pending goes.
  await expect(status.getByTestId("node-version")).toContainText("up to date", { timeout: 8000 })
  await expect(actions.getByTestId("node-update")).toHaveCount(0)

  await page.goto(page.url().replace(LIVING, GARAGE))
  await expect(page.getByTestId("node-status").getByTestId("device-status")).toContainText("Offline since")
  await expect(page.getByTestId("node-missing")).toContainText("install alsa-utils on the box")
  await expect(page.getByTestId("node-last-error")).toContainText("arecord is not installed")
  for (const command of ["identify", "test-speaker", "restart"]) await expect(page.getByTestId(`node-${command}`)).toBeDisabled()
  await expect(page.getByTestId("volume-test")).toBeDisabled()
})

test("Assistants on a node: follow-up off by the type's rule; no Look, Captions, voice page or browser Audio on a node or Every voice node", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  const jeff = page.locator("[data-assignment=jeff]")
  await expect(jeff.getByTestId("fu-follows")).toHaveText("Off: one answer per phrase (voice nodes)")
  await expect(jeff.getByLabel("Keep listening after a reply for Jeff")).toHaveValue("0")
  for (const page_ of [`#settings/devices/${KITCHEN}`, "#settings/devices/type.voice-node"]) {
    await page.goto(page.url().replace(/#.*$/, page_))
    await expect(page.getByTestId("section-sound")).toBeVisible()
    await expect(page.getByTestId("section-soundDevices")).toBeVisible()
    await expect(page.getByTestId("section-voice")).toBeVisible()
    await expect(page.getByTestId("section-look")).toHaveCount(0)
    await expect(page.getByTestId("section-voicePage")).toHaveCount(0)
    await expect(page.getByTestId("group-captions")).toHaveCount(0)
    await expect(page.getByTestId("group-audio")).toHaveCount(0)
  }
  // Every voice node has no Status, Actions or Remove.
  await expect(page.getByTestId("node-status")).toHaveCount(0)
  await expect(page.getByTestId("node-actions")).toHaveCount(0)
  await expect(page.getByTestId("forget")).toHaveCount(0)
  await expect(page.getByTestId("volume-test")).toHaveCount(0)
})

test("Sound and Sound devices: the volume test, the lists from the node's status, a stored device not connected, saved as own values", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${LIVING}`)
  await expect(page.getByTestId("marks-Sound").getByTestId("own-marker")).toBeVisible()
  await expect(page.getByTestId("node-volume-value")).toHaveText("60 %")
  await setRange(page, "node-volume", 75)
  await expect(page.getByTestId("volume-unsaved")).toContainText("Test plays the saved volume (60 %)")
  await page.getByTestId("volume-test").click()
  await expect.poll(async () => (await sent<{ command: string; durationMs?: number }>("node.command.send")).map((m) => [m.command, m.durationMs])).toEqual([["test-speaker", 1000]])

  const input = page.getByTestId("node-input")
  await expect(input).toHaveValue("alsa_input.usb-Anker_PowerConf-00.mono-fallback")
  await expect(input.locator("option:checked")).toHaveText("alsa_input.usb-Anker_PowerConf-00.mono-fallback (not connected)")
  await expect(page.getByTestId("node-input-gone")).toContainText("is not connected now")
  expect(await input.locator("option").allTextContents()).toEqual([
    "System default (Jabra SPEAK 510)",
    "Jabra SPEAK 510 · alsa_input.usb-Jabra_SPEAK_510-00.mono-fallback",
    "Built-in Audio Analog Stereo · alsa_input.pci-0000_00_1f.3.analog-stereo",
    "alsa_input.usb-Anker_PowerConf-00.mono-fallback (not connected)"
  ])
  await input.selectOption("alsa_input.usb-Jabra_SPEAK_510-00.mono-fallback")
  await page.getByTestId("node-output").selectOption("alsa_output.pci-0000_00_1f.3.hdmi-stereo")
  await save(page).click()
  await expect(page.getByTestId("page-footer")).toContainText("Saved. Applies at once.")
  const last = (await sent<{ target: { id: string }; settings: Record<string, unknown> }>("device.save")).at(-1)!
  expect(last.target.id).toBe(LIVING)
  expect(last.settings).toEqual({
    sound: { volume: 75, cues: true },
    soundDevices: { input: "alsa_input.usb-Jabra_SPEAK_510-00.mono-fallback", output: "alsa_output.pci-0000_00_1f.3.hdmi-stereo" }
  })
  // Reset goes back to Every voice node (null).
  await page.getByTestId("marks-Sound devices").getByTestId("reset").click()
  await save(page).click()
  await expect.poll(async () => (await sent<{ settings: Record<string, unknown> }>("device.save")).at(-1)?.settings).toEqual({ soundDevices: null })
  await expect(page.getByTestId("page-footer")).toContainText("Saved. Applies at once.")
  await expect(page.getByTestId("marks-Sound devices").getByTestId("follows-marker")).toHaveText("Follows Every voice node")

  // A node that never reported its devices: the selects wait for it.
  await mock.node(KITCHEN, { status: null })
  await page.goto(page.url().replace(LIVING, KITCHEN))
  await expect(page.getByTestId("page-title")).toHaveText("Kitchen speaker")
  await expect(page.getByTestId("node-input")).toBeDisabled()
  await expect(page.getByTestId("section-soundDevices")).toContainText("Connect the node to choose")
})

test("answering without a phrase on a node warns before it saves; Save anyway keeps it", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  await expect(page.getByTestId("answers-everything-note")).toHaveCount(0)
  await page.locator("#without-phrase").selectOption("jeff")
  await expect(page.getByTestId("answers-everything-note")).toContainText("would answer everything it hears")
  await save(page).click()
  const warning = page.getByTestId("warnings-dialog")
  await expect(warning).toContainText("A voice node would answer everything it hears, not one question per wake phrase.")
  await warning.getByRole("button", { name: "Save anyway" }).click()
  await expect(warning).toBeHidden()
  await expect(page.getByTestId("page-footer")).toContainText("Saved. Applies at once.")
  const saves = await sent<{ saveAnyway?: boolean; settings: Record<string, unknown> }>("device.save")
  expect(saves.map((s) => s.saveAnyway === true)).toEqual([false, true])
  expect(saves[1]!.settings.withoutPhrase).toEqual({ mode: "assistant", assistant: "jeff" })
})

test("remove a node with its confirmation: it is gone for good", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  await page.getByTestId("forget").click()
  const confirm = page.getByRole("alertdialog")
  await expect(confirm).toContainText("Remove Kitchen speaker?")
  await expect(confirm).toContainText("The node disconnects and must be paired again to come back.")
  await confirm.getByRole("button", { name: "Keep it" }).click()
  await expect(confirm).toBeHidden()
  expect(await sent("device.forget")).toEqual([])
  await page.getByTestId("forget").click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click()
  await expect(page.getByTestId("device-list")).toBeVisible()
  await expect(page.locator(`[data-device=${KITCHEN}]`)).toHaveCount(0)
  await expect(page.getByTestId("device-type-voice-node").getByTestId("type-count")).toHaveText("2 voice nodes")
  expect(await sent<{ id: string }>("device.forget")).toEqual([expect.objectContaining({ id: KITCHEN })])
})

test("no sideways scroll at 320 px: the list, a node's page, the dialog", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await loginAdmin(page, baseURL, "#settings/devices")
  await expect(page.getByTestId("device-type-voice-node")).toBeVisible()
  await noSidewaysScroll(page)
  await page.goto(page.url().replace(/#.*$/, `#settings/devices/${LIVING}`))
  await expect(page.getByTestId("section-soundDevices")).toBeVisible()
  await noSidewaysScroll(page)
  await page.goto(page.url().replace(/#.*$/, "#settings/devices"))
  await mock.nodes({ tls: true, tlsPin: exampleNodePairing.tlsPin!, redeemAfterMs: 0 })
  await page.getByTestId("add-node-button").first().click()
  await page.locator("#node-server").fill("https://assistant.home:8443")
  await page.getByTestId("get-code").click()
  await expect(page.getByTestId("install-command")).toBeVisible()
  await noSidewaysScroll(page)
})
