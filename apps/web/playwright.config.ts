import { defineConfig, devices } from "@playwright/test"
import { fakeMicPath } from "./e2e/fixtures.ts"

/**
 * End-to-end tests in headless Chromium against the mock assistant, with a fake
 * microphone. The full suite runs against the static export (`out/`, served by
 * a plain static file server: what ships); a smoke test also runs against `next dev`.
 * Run `pnpm --filter @pva/web build` first (the `e2e` script does).
 */
const chromiumArgs = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  `--use-file-for-fake-audio-capture=${fakeMicPath}`
]

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1, // one shared mock server
  retries: 0,
  timeout: 45_000,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    browserName: "chromium",
    permissions: ["microphone"],
    launchOptions: { args: chromiumArgs },
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "static",
      testIgnore: /dev-smoke/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3200", viewport: { width: 1280, height: 800 } }
    },
    {
      name: "screenshots",
      testMatch: /\.shots\.ts$/,
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3200" }
    },
    {
      name: "dev",
      testMatch: /dev-smoke/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3100", viewport: { width: 1280, height: 800 } }
    }
  ],
  webServer: [
    { command: "MOCK_QUIET=1 pnpm exec tsx mock/server.ts", url: "http://127.0.0.1:8787/mock/log", reuseExistingServer: true },
    { command: "node scripts/serve-static.mjs out 3200", url: "http://127.0.0.1:3200", reuseExistingServer: true },
    { command: "pnpm exec next dev -p 3100", url: "http://localhost:3100", reuseExistingServer: true, timeout: 120_000 }
  ]
})
