import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "docs/research/*/lab/test/**/*.test.ts"],
          exclude: ["**/node_modules/**", "apps/web/**"],
          globalSetup: ["./vitest.global-setup.ts"]
        }
      },
      // The web app has its own config (jsdom, path aliases).
      "apps/web"
    ]
  }
})
