import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // A single static page: the assistant's server serves `out/` and the WebSocket on one origin.
  output: "export",
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
