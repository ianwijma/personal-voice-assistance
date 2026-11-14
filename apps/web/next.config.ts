import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // A single static page: the assistant's server serves `out/` and the WebSocket on one origin.
  output: "export",
  // `PVA_WEB_EXPORT_DIR` exports somewhere else than `out/` (the real-browser tests build to `out-e2e/`, so they
  // never rewrite the page a running assistant is serving from `out/`).
  ...(process.env.PVA_WEB_EXPORT_DIR ? { distDir: process.env.PVA_WEB_EXPORT_DIR } : {}),
  images: { unoptimized: true },
  // The workspace package ships TypeScript source; Next must compile it.
  transpilePackages: ["@pva/protocol"],
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" }
    }
  }
}

export default nextConfig
