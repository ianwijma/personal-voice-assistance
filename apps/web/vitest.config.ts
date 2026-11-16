import { defineConfig } from "vitest/config"
import { generateCharacterRegistry } from "./scripts/build-characters.mjs"

// The character list is generated (git-ignored); write it here too, so `vitest` and the root `pnpm test` find it.
generateCharacterRegistry()

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"]
  }
})
