---
name: orchestration-tracking-release
description: Manually publish a verified post-merge source release for this repository.
---

# Orchestration tracking source release

Use this checklist only after the pull request has been merged. These are
manual commands, not release automation. Run them from a clean checkout of
this repository and stop if any verification fails.

## Verify the merged pull request, commit, and version

Set `PR` to the supplied merged pull request number or URL. Do not use the
current branch tip as a substitute for the pull request's merge commit.

```sh
test -z "$(git status --short)"
PR="<merged pull request number or URL>"
test -n "$PR"
test "$(gh pr view "$PR" --json state --jq '.state')" = "MERGED"
test "$(gh pr view "$PR" --json baseRefName --jq '.baseRefName')" = "main"
test -n "$(gh pr view "$PR" --json mergedAt --jq '.mergedAt')"
MERGED_COMMIT="$(gh pr view "$PR" --json mergeCommit --jq '.mergeCommit.oid')"
test -n "$MERGED_COMMIT"
test "$MERGED_COMMIT" != "null"
git fetch origin main --tags
git rev-parse --verify "$MERGED_COMMIT^{commit}"
git merge-base --is-ancestor "$MERGED_COMMIT" origin/main
VERSION="$(git show "$MERGED_COMMIT:package.json" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(JSON.parse(s).version))')"
test -n "$VERSION"
TAG="v$VERSION"
PREFIX="orchestration-tracking-$VERSION"
ARCHIVE="$PREFIX.tar.gz"
```

The pull request must be merged into `main`, have a merge timestamp, and
provide a merge commit SHA. The exact SHA must resolve locally and be
reachable from fetched `origin/main`; the release version is read from that
commit's `package.json`. Do not switch to, pull, or commit on a reference
branch.

## Verify, create, and push the tag

Fetch tags before checking availability. The release tag must not already
exist locally or on the remote:

```sh
test -z "$(git tag --list "$TAG")"
test -z "$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")"
git tag -a "$TAG" "$MERGED_COMMIT" -m "$TAG"
test "$(git rev-parse "$TAG^{commit}")" = "$MERGED_COMMIT"
git push origin "$TAG"
git fetch origin tag "$TAG"
test "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$MERGED_COMMIT"
```

## Create and verify the source archive

Create the archive from the verified tag, which was checked to resolve to the
exact pull request merge SHA, with the required root directory:

```sh
git archive --format=tar.gz --prefix="$PREFIX/" "$TAG" > "$ARCHIVE"
test -s "$ARCHIVE"
shasum -a 256 "$ARCHIVE"
test "$(tar -tzf "$ARCHIVE" | sed -n '1p')" = "$PREFIX/"
tar -tzf "$ARCHIVE" | awk -v prefix="$PREFIX/" 'index($0, prefix) != 1 { print; bad = 1 } END { exit bad }'
```

Record the SHA-256 digest for release verification. Confirm that the archive
contains the expected project files and no path outside
`orchestration-tracking-$VERSION/`.

## Publish the GitHub release

After verifying the tag and archive, publish the release with a concise
release-specific Highlights section and attach the archive. Set
`RELEASE_HIGHLIGHTS` to the content for this release; the command refuses an
unset or empty value:

```sh
test -n "${RELEASE_HIGHLIGHTS:-}"
gh release create "$TAG" "$ARCHIVE" --title "$TAG" --notes "## Highlights

$RELEASE_HIGHLIGHTS"
```

Verify the published release title, notes, tag, and attached archive with
`gh release view "$TAG"` before closeout.

## Post-release closeout

Only after the merge and GitHub release succeed, perform any applicable
private Bead closeout through the approved Hub workflow. Invoke tracker
closeout only after that workflow reports closeout complete.
