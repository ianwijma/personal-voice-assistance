# syntax=docker/dockerfile:1
# Personal voice assistant, serve mode. See docs/DEPLOYMENT.md.
# glibc base: the sherpa-onnx native library ships prebuilt glibc binaries (no Alpine).
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# flock (util-linux): the data directory's writer lock. tar + bzip2: unpacking the speech models.
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux tar bzip2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Same version as "packageManager" in package.json.
RUN npm install -g pnpm@10.34.9 && npm cache clean --force && rm -rf /tmp/node-compile-cache

WORKDIR /app
COPY --chown=1000:1000 . .
RUN chown 1000:1000 /app

USER 1000:1000
# The page is a static export; Next.js, its compiler and Playwright are only needed for the build, so they are
# removed afterwards (about 300 MB). The pnpm store stays out of the image.
RUN pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store \
 && pnpm --filter @pva/web build \
 && rm -rf /tmp/pnpm-store /home/node/.cache /home/node/.npm /app/apps/web/.next \
 && rm -rf /app/node_modules/.pnpm/next@* /app/node_modules/.pnpm/@next+swc-* /app/node_modules/.pnpm/@playwright+test@*

USER root
RUN mkdir -p /data /app/models && chown 1000:1000 /data /app/models
USER 1000:1000

# HOME and the tsx cache point at /tmp so the root file system can be read-only (/tmp must be writable).
ENV NODE_ENV=production \
    SERVE_HOST=0.0.0.0 \
    SERVE_PORT=8787 \
    PVA_DATA_DIR=/data \
    PVA_VAULT_PATH=/data/vault.enc \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache

VOLUME ["/data", "/app/models"]
EXPOSE 8787
WORKDIR /app/apps/assistant

# Node is PID 1 and handles SIGTERM itself. The web page is already built; nothing writes to /app at runtime.
# Model download (idempotent, for an initContainer):
#   node --import tsx /app/packages/stt-sherpa/scripts/download-models.ts
#   node --import tsx /app/packages/tts-sherpa/scripts/download-models.ts
ENTRYPOINT ["node"]
CMD ["--import", "tsx", "src/main.ts", "serve"]
