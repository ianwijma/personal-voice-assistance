import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Two static pages: the voice front end (`/` → `out/index.html`) and admin (`/admin/` → `out/admin/index.html`).
  // The assistant's server serves `out/` and the WebSocket on one origin. `trailingSlash` makes every route a
  // directory with an `index.html` (docs/FRONTENDS-AND-ACTIVATION.md, Status: URL layout); `/admin` redirects to `/admin/`.
  output: "export",
  trailingSlash: true,
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
