import { defineConfig, devices } from "@playwright/test"

/**
 * End-to-end tests against the REAL assistant: `pnpm start serve` with the local
 * speech models and `LLM_PROVIDER=fake`, serving the built UI (`out/`), in headless
 * Chromium with a fake microphone fed from WAV files (docs/UI-AND-MODULES.md §6.3).
 * Each test file starts its own assistant on its own port. Run with `pnpm e2e:real`
 * from the repository root (builds the UI first). Skips when the models, the bench
 * audio or Chromium are missing.
 */
export default defineConfig({
  testDir: "e2e-real",
  fullyParallel: false,
  workers: 1, // the speech models use most of the CPU; one assistant at a time keeps timings honest
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  outputDir: "test-results/real",
  use: {
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    viewport: { width: 1280, height: 800 },
    permissions: ["microphone"],
    trace: "retain-on-failure"
  },
  projects: [
    { name: "real", testMatch: /\.real\.ts$/ },
    { name: "real-latency", testMatch: /\.latency\.ts$/, timeout: 300_000 },
    { name: "real-screenshots", testMatch: /\.shots\.ts$/, timeout: 300_000 }
  ]
})
