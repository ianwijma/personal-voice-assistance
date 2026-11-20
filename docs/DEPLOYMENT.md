# Deployment (container image)

How to run serve mode from the container image, for example on Kubernetes. The image runs `pnpm serve`'s server half
(`src/main.ts serve`); the web page is built into it. Everything below was checked with Docker 29 on an amd64 machine
unless it says otherwise.

## Image

`ghcr.io/ianwijma/personal-voice-assistant` (linux/amd64 only), built by `.github/workflows/image.yml`:

| Trigger | Tags |
|---|---|
| push to `main`, or `workflow_dispatch` on `main` | `sha-<7 characters of the commit>`, `main` |
| pull request from this repository with the label `preview` | `pr-<number>-<full head commit sha>` (the head commit, not the merge commit) |

There is no `latest` tag. Pull requests from forks never build. A labelled PR gets a LAN-only preview deployment in the
homelab cluster at `https://pva-pr-<n>.k3s.lab.wijma.cloud`, started from a copy of production's data volume.

The base is `node:22.23.5-bookworm-slim` (pinned by digest; Debian, not Alpine, because the speech library ships
prebuilt glibc binaries). It adds `util-linux` (`flock`), `tar`, `bzip2` and `ca-certificates`, and pnpm 10.34.9 (the
`packageManager` version). The image is about 1.6 GB on disk (380 MB compressed); the speech models are not in it.

## Build and run locally

```sh
docker build -t pva:local .
docker volume create pva-data && docker volume create pva-models
# first run only: fetch the default speech models (about 710 MB, about 45 s on a fast line)
docker run --rm -v pva-models:/app/models pva:local --import tsx /app/packages/stt-sherpa/scripts/download-models.ts
docker run --rm -v pva-models:/app/models pva:local --import tsx /app/packages/tts-sherpa/scripts/download-models.ts
docker run --rm --name pva -p 127.0.0.1:8787:8787 \
  -v pva-data:/data -v pva-models:/app/models \
  -e PVA_ADMIN_PASSWORD=change-me-please -e PVA_VAULT_PASSWORD=change-me-too \
  pva:local
```

Open `http://127.0.0.1:8787/` (the admin page is `/admin/`). Browsers allow the microphone only on `https://` or
`localhost`.

## Contract

- User `1000:1000` (`node`). Working directory `/app/apps/assistant`. `ENTRYPOINT ["node"]`,
  `CMD ["--import", "tsx", "src/main.ts", "serve"]`. Node is PID 1 and handles `SIGTERM`.
- Port 8787: the web page, the admin API (`/api/`) and the WebSocket (`/ws`).
- Environment set in the image: `NODE_ENV=production` (does not affect `tsx`), `SERVE_HOST=0.0.0.0`,
  `SERVE_PORT=8787`, `PVA_DATA_DIR=/data`, `PVA_VAULT_PATH=/data/vault.enc`, `HOME=/tmp`, `XDG_CACHE_HOME=/tmp/.cache`.
- Set by you: `PVA_ADMIN_PASSWORD` (at least 8 characters; without it nothing can be configured from a browser),
  `PVA_VAULT_PASSWORD` (unlocks the key vault at start), and behind a reverse proxy `SERVE_BEHIND_PROXY=true`,
  `SERVE_ALLOWED_HOSTS` (host names the server answers to, besides IP addresses and `localhost`; any other `Host` gets
  403) and `SERVE_ALLOWED_ORIGINS` (page origins allowed to open the WebSocket, e.g. `https://pva.example.org`).
  The other variables are in `.env.example` and the README.
- `PVA_VAULT_PATH` is set to `/data/vault.enc` on purpose. Without it the vault is written under `$HOME/.config/pva`,
  which is `/tmp` here and would be lost.

## Volumes

| Path | Holds | Notes |
|---|---|---|
| `/data` (`PVA_DATA_DIR`) | settings, key vault, household SQLite database, recordings, backups, writer lock | must be persistent and writable by uid 1000 |
| `/app/models` | speech models (about 710 MB for the defaults) | persistent so models are downloaded once; writable by uid 1000 |

Both directories exist in the image and are owned by 1000:1000. A Kubernetes volume mounted over them needs
`fsGroup: 1000` (or an owner of 1000) when the storage does not preserve ownership.

The models directory is configurable: `STT_SHERPA_MODEL_DIR` and `TTS_SHERPA_MODEL_DIR` (environment, or the saved
setting of the same name) move the recogniser's and the voice's models; the download scripts take `--model-dir <dir>`
(the voice script also reads `TTS_SHERPA_MODEL_DIR`). The default is `/app/models`, which is what the image uses.

On-disk layout of `/data` after the first start (top-level names): `backups/`, `household.db`, `household.db-shm`,
`household.db-wal`, `media/`, `writer.lock`, `writer.holder`; `vault.enc` appears once the vault exists. `settings.json`
appears when the first setting is saved, and `recordings/` when recordings are written.

## Models

Serve mode starts without models and stays up: the voice and the recogniser report "failed" with the missing file in
the log and in the admin Overview, and they can be downloaded from the admin page (Settings, Models) while it runs.

The defaults serve mode needs are the recogniser preset `parakeet-v2` (with the Silero VAD) and the voice preset
`en_US-lessac-medium`. To fetch them before the server starts (a Kubernetes `initContainer` with the same image and
the models volume mounted; use `command`, which replaces the entrypoint):

```
node --import tsx /app/packages/stt-sherpa/scripts/download-models.ts
node --import tsx /app/packages/tts-sherpa/scripts/download-models.ts
```

(`sh -c '<first> && <second>'` makes it one init container.) Both are idempotent: with the models present they print
"Already downloaded" and exit 0 in under a second each (about 1.7 s together, mostly Node and `tsx` starting). The first
run needs outbound HTTPS to `github.com`. Other presets: add the preset name as an argument (`--list` shows them).

## Single replica

Run exactly one replica (a `StatefulSet` of 1 or a `Deployment` with strategy `Recreate`, not a rolling update). Serve
is the only writer of the data directory and takes a single-writer lock on it (`apps/assistant/src/serve/DataDirLock.ts`):
an advisory `flock` lock on `/data/writer.lock`, held until the process exits. A second server on the same directory
exits with status 1 and "Cannot use the data directory /data: another assistant is using it (process … on …)".

The lock is the kernel's, so it is released when the process dies, `SIGKILL` included; there is no stale lock to clean
up. `/data/writer.holder` (process id, host name, kernel boot id, start time) only describes the holder, and is
removed on a clean stop. After an unclean exit it stays behind and the next server logs "did not stop cleanly" and
overwrites it. Checked after `docker kill -s KILL`:

- a new container with a different host name on the same volume (same kernel) started normally;
- a new container with the same host name started normally.

The one case that refuses: a `writer.holder` left by a different host name on a different kernel (a different boot id),
which is what a pod rescheduled to another node under a new name looks like. The error is "it was last used by an
assistant on another machine … If none is running there, delete /data/writer.holder and start again." Only that file
needs deleting; `writer.lock` stays. The same host name never refuses (a StatefulSet pod keeps its name). So a
`StatefulSet` is the safer shape; a `Deployment` works as long as the pod lands on the same node or an init container
deletes `/data/writer.holder` first. The different-kernel case was simulated by editing the boot id in the holder file,
since a second kernel is not available locally.

Shutdown: `docker stop` ends the container in about 0.5 s; the server closes its sockets, takes the day's database
backup, releases the lock and removes `writer.holder`. The exit status is 130 (the app's `SIGTERM` handling), not 0.

### Copying the data volume (previews)

A copy of a live `/data`, taken while production runs, behaves like a crash (the SQLite write-ahead log is copied with
the database and recovered at start). Checked by copying the files of a running instance to a new volume (as root, to
keep ownership) and starting another container with a different host name on the copy while the original kept running:
it started, logged "did not stop cleanly", and the vault unlocked with the same `PVA_VAULT_PASSWORD`. The `flock` lock
does not travel with a copy. On a different kernel, a copy carries production's `writer.holder` and the start refuses
as above, so the preview's init container must delete `/data/writer.holder`. Nothing else needs to be removed. The vault
is only created from the UI (Settings, Keys & access): `PVA_VAULT_PASSWORD` unlocks an existing vault at start and logs a
warning when there is none.

## Health and readiness

There is no dedicated health endpoint. `GET /` returns 200 once the server listens (about 2.6 s from start with models
present, 11 s including a cold `docker run`), and the kubelet's probe is fine: a request with an IP address as `Host`
(`10.1.2.3:8787` or none at all) is allowed and gets 200; only a name that is not an IP, not `localhost` and not in
`SERVE_ALLOWED_HOSTS` gets 403. Use `httpGet` on `/` port 8787 for liveness and readiness. A 200 does not say the
speech engines are ready; the log line "Engines ready." and the admin Overview do. The WebSocket path is `/ws`; with
an allowed `Origin` the upgrade returns 101, with another origin 403. `/api/` answers 401 without an admin session.

## Read-only root file system

`docker run --read-only --tmpfs /tmp:uid=1000 …` works. The only path outside `/data` and `/app/models` that is
written is `/tmp` (the `tsx` transpile cache, `/tmp/tsx-1000`, and `HOME`). `pnpm` is not used at runtime and nothing
writes to `/app`. Memory: about 1.1 GiB at idle with the default models loaded (`docker stats`).
