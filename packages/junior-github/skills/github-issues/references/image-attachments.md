# Image attachments via GitHub Release assets

Embed an image inline in an issue, PR, or comment body using only `gh` — no third-party image host, no extra token.

## Mechanism

GitHub serves release-asset download URLs directly to the browser (no camo proxy for `github.com` URLs). Upload the image as an asset on a shared, append-only release, then reference its stable download URL as `![]()` markdown.

Visibility follows the host repo: a private host repo renders the image for readers with repo access and 404s for everyone else; a public host repo is world-visible. Always host in the repo the issue/PR/comment lives in so visibility matches the audience — never stage a private screenshot through a public repo.

## Procedure

Given an image at `$IMG` and target repo `$REPO` (`owner/repo`, resolved the same way as any other operation in this skill):

```bash
TAG="_attachments"   # one shared, append-only release per repo for all attachments

# 1. Ensure the attachments release exists (idempotent). Create it WITHOUT
#    passing files — passing files to `gh release create` also publishes the
#    release via a PATCH that Junior's write allowlist denies.
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || \
  gh release create "$TAG" --repo "$REPO" --title attachments --notes "image attachments" --latest=false

# 2. Upload with a collision-proof name (hash/random suffix avoids overwriting
#    an already-linked image). Never use `--clobber` — asset overwrite/delete
#    is not part of this workflow.
NAME="$(basename "${IMG%.*}")-$(head -c4 /dev/urandom | xxd -p).${IMG##*.}"
gh release upload "$TAG" "$IMG#$NAME" --repo "$REPO"

# 3. Build the URL and embed it.
URL="https://github.com/$REPO/releases/download/$TAG/$NAME"
echo "![${NAME}]($URL)"
```

Then include `![]($URL)` in the issue/PR/comment body via the normal creation or edit path for that operation.

## Rules

- **Append-only.** Never delete the `_attachments` release or its assets — the download URL points at live storage, and deleting an asset turns every historical embed into a broken image.
- **Unique filenames, no `--clobber`.** Always suffix with a hash/random string instead of overwriting. Asset delete is not part of this workflow and is denied by Junior's write allowlist.
- **Never pass files directly to `gh release create`.** That publishes the release via a PATCH request, which is denied. Create the (draft, unpublished-is-fine) release first, then upload separately.
- **Match host visibility to audience.** Host in the repo the content lives in so private images stay private.
- **Only use this for images that need to render inline in GitHub markdown** (screenshots, diagrams, charts from a Slack thread or elsewhere). Don't use it as a general-purpose file store.

## Requirements

- GitHub App `Contents: write` on the target repository (this covers release create/read/update and asset upload, the same permission repository content pushes already use).
- Junior's GitHub plugin classifies release-create (`POST /repos/{owner}/{repo}/releases`) and asset-upload (`POST` to `uploads.github.com/repos/{owner}/{repo}/releases/{id}/assets`) as an allowed installation write scoped to the target repository, and the plugin manifest lists `uploads.github.com` as an egress domain (`packages/junior-github/src/index.ts`). Release edit/delete and asset delete are intentionally denied — this workflow is append-only by policy, not just by convention. If `gh release create`/`gh release upload` ever fails with an egress/policy denial, that's a regression in this classification — don't retry with a workaround; report the exact failure.

Source technique: https://gist.github.com/CatalanCabbage/649aae8f9a7b813776b22340b0f07d05
