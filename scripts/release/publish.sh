#!/usr/bin/env bash
# Release workflow, `release` job: creates the GitHub Release for TAG. Its notes start with the image reference
# (tag and digest), followed by GitHub's generated notes. On a re-run, when the release already exists, it keeps the
# release and only corrects the digest in its notes (a re-run of the `image` job gives a new one).
#
# Environment:
#   TAG         the release tag (already pushed)
#   VERSION     the version being released (the image tag)
#   PRERELEASE  true|false
#   IMAGE       the image repository, e.g. ghcr.io/ianwijma/personal-voice-assistant
#   DIGEST      the pushed image's digest (sha256:...)
#   GH_TOKEN    for the gh CLI, with contents: write
set -euo pipefail

: "${TAG:?}" "${VERSION:?}" "${PRERELEASE:?}" "${IMAGE:?}" "${DIGEST:?}"
if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::Not an image digest: ${DIGEST}"
  exit 1
fi
if [[ "$PRERELEASE" == "true" ]]; then kind=(--prerelease); else kind=(--latest); fi

if body="$(gh release view "$TAG" --json body --jq .body 2>/dev/null)"; then
  if [[ "$body" != *"$DIGEST"* ]]; then
    gh release edit "$TAG" --notes "$(sed -E "s/sha256:[0-9a-f]{64}/${DIGEST}/g" <<< "$body")"
  fi
  exit 0
fi

notes="## Container image

\`\`\`sh
docker pull ${IMAGE}:${VERSION}
\`\`\`

linux/amd64, digest \`${DIGEST}\`. Pin it as \`${IMAGE}:${VERSION}@${DIGEST}\`.
How to run it: [docs/DEPLOYMENT.md](https://github.com/${GITHUB_REPOSITORY:?}/blob/${TAG}/docs/DEPLOYMENT.md).
"

gh release create "$TAG" --verify-tag --generate-notes --notes "$notes" --title "$TAG" "${kind[@]}"
