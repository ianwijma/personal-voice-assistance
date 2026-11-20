# Releasing

The [Release workflow](../.github/workflows/release.yml) checks and tests the code, bumps the version, tags it, builds
the container image and pushes it, and creates a GitHub Release. Nothing is published to npm (the packages are
`private`).

Each release is:

| What | Where |
|---|---|
| The image `ghcr.io/ianwijma/personal-voice-assistant:X.Y.Z` (linux/amd64) | GitHub Container Registry. The tag is the version without the `v`. How to run it: [DEPLOYMENT.md](DEPLOYMENT.md). |
| The git tag `vX.Y.Z` | On the release commit on `main`, which sets `"version"` in the root `package.json`. |
| The GitHub Release `vX.Y.Z` | Its notes start with the image reference and its digest, followed by GitHub's generated notes. |

A release does not move the `main` or `sha-…` image tags and there is no `latest` tag: those rules are the Image
workflow's ([DEPLOYMENT.md](DEPLOYMENT.md), "Image"). The release commit is pushed by the workflow's own token, so it
starts neither the CI nor the Image workflow; the release image is the only image of that commit.

The version lives in the root `package.json` only. The workspace packages stay at `0.0.0`.

## Run a release

1. Open **Actions → Release → Run workflow**.
2. Leave the branch on `main`.
3. Pick a **Version bump** (default `patch`):
   - `patch`: `1.2.3` → `1.2.4`, for bug fixes.
   - `minor`: `1.2.3` → `1.3.0`, for new features that don't break anything.
   - `major`: `1.2.3` → `2.0.0`, for breaking changes.
4. Pick a **Release type** (default `prerelease`, so you never release a stable version by accident):
   - `prerelease`: a release candidate, marked as a prerelease on GitHub. `1.2.3` + `minor` → `1.3.0-rc.0`.
   - `release`: a stable version, marked as the latest release. `1.2.3` + `minor` → `1.3.0`.
5. **Dry run** is ticked by default: it checks and builds everything without pushing or releasing. Untick it to
   release for real.
6. **Prerelease identifier** (default `rc`) is only used for prereleases; `beta` gives `1.3.0-beta.0`.
7. Click **Run workflow**.
8. Open the run's summary. The plan is there within a minute: the current and new version, the latest GitHub Release
   and git tag, the image that will be pushed, any blockers, and the changes since the last release. **Plan release**
   then goes on to the typecheck, the tests and the image build (about 20 minutes).
9. When **Plan release** is green and the plan is correct, click **Review deployments**, tick `release` and
   **Approve and deploy**. To stop, click **Reject** instead.
10. Wait for **Build image** and **Release** to go green and check the new GitHub Release.

One release runs at a time. A second run waits for the first; starting a third replaces the waiting one.

Release candidates, step by step (keep the same **Version bump** each time):

- `minor` + `prerelease`: `1.2.3` → `1.3.0-rc.0`.
- `minor` + `prerelease` again: `1.3.0-rc.0` → `1.3.0-rc.1`, `1.3.0-rc.2`, ...
- `minor` + `release`: `1.3.0-rc.2` → `1.3.0`.
- A bigger bump on a candidate starts a new one: `major` + `prerelease` on `1.3.0-rc.2` → `2.0.0-rc.0`.

`package.json` starts at `0.0.0`, so the first release is for example `minor` + `prerelease` → `0.1.0-rc.0`.

### What the workflow does

- **Plan:** works out the new version (`scripts/next-version.ts`) and writes the summary. It stops on a blocker: the
  tag or GitHub Release already exists, or a stable version isn't newer than the latest stable GitHub Release. Then it
  runs the same typecheck and tests as the CI workflow and builds the image without pushing it.
- **Version:** waits for your approval on the `release` environment, then commits the new version to `main`
  (`chore(release): vX.Y.Z`) and pushes a `vX.Y.Z` tag. If `main` got new commits after the run
  started, it stops instead.
- **Build image:** checks out the tag, builds the image from the `Dockerfile` and pushes it as
  `ghcr.io/ianwijma/personal-voice-assistant:X.Y.Z`, with the version, the commit and the build time as
  `org.opencontainers.image.*` labels.
- **Release:** creates the GitHub Release with the image reference and digest and the generated notes
  (`scripts/release/publish.sh`).

The longer steps live in `scripts/release/` (`plan.sh`, `publish.sh`); each documents the environment variables it
reads at the top.

A dry run stops after **Build image**: the image is built from the commit with the new version applied, and not
pushed. Nothing is committed, tagged or released.

### If it fails

- **Build image or Release failed:** click **Re-run failed jobs**. It builds the tag that was already pushed, without
  bumping again. A release that was already created is kept; if the image was built again, the digest in its notes is
  corrected.
- **Plan failed with "Could not look up" or "Could not check":** GitHub or the remote couldn't be queried, so the
  blockers weren't checked. Run it again later.
- **Plan failed in the tests:** the same tests as CI; fix `main` (or re-run, for a test that depends on the load of
  the machine) and start a new run.
- **Version failed at the push:** `main` got new commits after the run started. Start a new run; nothing was pushed.
- **"may not run releases":** only the repository owner can release, unless the `RELEASE_ACTORS` repository variable
  lists your GitHub login.

## One-time setup

1. **Merge the workflow into `main`.** GitHub only shows a manually started workflow once its file is on the default
   branch.
2. **Create the `release` environment** (the approval gate): **Settings → Environments → New environment**, name it
   `release`.
   - Tick **Required reviewers** and add yourself.
   - Leave **Prevent self-review** unticked, or you can't approve your own releases.
   - Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main`.

   Without required reviewers the workflow doesn't wait for approval.
3. **Check the Actions settings:** under **Settings → Actions → General**, check that Actions are allowed. The
   workflow sets its own permissions, so the **Workflow permissions** default can stay on "Read repository contents".
4. **Optional, allow other people to release:** add a repository variable under **Settings → Secrets and variables →
   Actions → Variables**: name `RELEASE_ACTORS`, value a list of GitHub logins (`ianwijma otheruser`). They also need
   write access to the repository.
5. **Try it:** run a dry run with the defaults and approve it. Then run it again with **Dry run** unticked.

If you later protect `main` with a rule that blocks direct pushes, add **GitHub Actions** to its bypass list. Otherwise
the workflow can't push the release commit.
