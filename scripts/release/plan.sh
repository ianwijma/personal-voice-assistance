#!/usr/bin/env bash
# Release workflow, `plan` job: checks for blockers and writes the release plan to the job summary. Exits non-zero
# (after writing the summary) on a blocker, so nothing is pushed or released.
#
# Environment:
#   VERSION, TAG, PRERELEASE     from scripts/next-version.ts (PRERELEASE: true|false)
#   BUMP, RELEASE_TYPE, DRY_RUN  the workflow inputs
#   IMAGE                        the image repository, e.g. ghcr.io/ianwijma/personal-voice-assistant
#   GH_TOKEN                     for the gh CLI
#   GITHUB_STEP_SUMMARY, GITHUB_REF_NAME  set by GitHub Actions
set -euo pipefail

: "${VERSION:?}" "${TAG:?}" "${PRERELEASE:?}" "${BUMP:?}" "${RELEASE_TYPE:?}" "${DRY_RUN:?}" "${IMAGE:?}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
cd "$(dirname "$0")/../.."

current="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"
# The lookups below tell "not there" apart from a failed query (network, auth, API errors): a failed query stops the
# plan, so it never reports a blocker as absent.

# Prints the tag of a release, or "none" when there is no such release.
# Without arguments: the release marked latest (never a prerelease or draft).
release_tag() {
  local out
  if out="$(gh release view "$@" --json tagName --jq .tagName 2>&1)"; then
    echo "$out"
  elif [[ "$out" == "release not found" ]]; then
    echo none
  else
    echo "::error::Could not look up GitHub Releases: ${out}" >&2
    return 1
  fi
}

gh_latest="$(release_tag)"
gh_newest="$(gh release list --limit 1 --json tagName --jq '.[0].tagName // "none"')"
# Local only: fails when no `v*` tag exists yet.
last_tag="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo none)"
gh_release="$(release_tag "$TAG")"

# --exit-code: 0 = the tag exists, 2 = it does not, anything else = the query failed.
tag_status=0
git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null || tag_status=$?
if (( tag_status != 0 && tag_status != 2 )); then
  echo "::error::Could not check the remote for the tag ${TAG} (git ls-remote exit ${tag_status})."
  exit 1
fi

# Each check is a blocker: the run stops here and nothing is pushed or released.
blockers=()
if (( tag_status == 0 )); then
  blockers+=("The tag \`${TAG}\` already exists.")
fi
if [[ "$gh_release" != none ]]; then
  blockers+=("A GitHub Release for \`${TAG}\` already exists.")
fi
if [[ "$PRERELEASE" != "true" && "$gh_latest" != "none" ]] \
  && ! node --input-type=module -e 'import semver from "semver"; process.exit(semver.gt(process.argv[1], process.argv[2]) ? 0 : 1)' "$VERSION" "${gh_latest#v}"; then
  blockers+=("\`${VERSION}\` is not newer than the latest GitHub Release (\`${gh_latest}\`).")
fi

if [[ "$PRERELEASE" == "true" ]]; then
  latest_after="\`${gh_latest}\` (\`${TAG}\` as a prerelease)"
else
  latest_after="\`${TAG}\`"
fi
if [[ "$last_tag" == none ]]; then range=HEAD; else range="${last_tag}..HEAD"; fi

{
  echo "## Release plan: \`${current}\` → \`${VERSION}\`"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "> **Dry run:** nothing will be pushed or released. The image is built but not pushed."
  fi
  echo
  echo "| | Now | After this release |"
  echo "|---|---|---|"
  echo "| \`package.json\` on \`${GITHUB_REF_NAME:-HEAD}\` | \`${current}\` | \`${VERSION}\` |"
  echo "| Latest GitHub Release | \`${gh_latest}\` | ${latest_after} |"
  echo "| Newest GitHub Release (incl. prereleases) | \`${gh_newest}\` | \`${TAG}\` |"
  echo "| Git tag | \`${last_tag}\` | \`${TAG}\` |"
  echo
  echo "- **Version bump:** \`${BUMP}\`, **release type:** \`${RELEASE_TYPE}\`"
  echo "- **Commit:** \`$(git rev-parse --short HEAD)\` on \`${GITHUB_REF_NAME:-HEAD}\`"
  echo "- **Image pushed by the release:** \`${IMAGE}:${VERSION}\` (linux/amd64)"
  echo
  echo "### Blockers"
  if (( ${#blockers[@]} )); then
    for b in "${blockers[@]}"; do echo "- ❌ ${b}"; done
  else
    echo "- ✅ None. Approve the \`release\` environment under **Review deployments** to continue, or reject it to stop."
  fi
  echo
  echo "### Changes since \`${last_tag}\`"
  git log --no-merges -n 50 --format='- %s (`%h`)' "$range"
} >> "$summary"

for b in "${blockers[@]}"; do echo "::error::${b//\`/}"; done
(( ${#blockers[@]} == 0 ))
