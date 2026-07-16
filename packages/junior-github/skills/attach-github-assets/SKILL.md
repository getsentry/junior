---
name: attach-github-assets
description: Upload concrete local images or videos to GitHub user attachments and return markdown-ready links. Use when a user asks to attach a local screenshot, recording, image, or video to a GitHub pull request, issue, body, or comment. Do not use for remote URLs or when no local file path is available.
---

# Attach GitHub Assets

Upload each user-provided local file with `scripts/upload.sh`. Do not replace the upload with a description of what the user could do manually.

## Preconditions

Proceed only when both are true:

- The request identifies a concrete local path for a supported image or video.
- The destination is a GitHub pull request, issue, body, or comment.

Supported extensions: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `mov`, `mp4`, `webm`.

Do not upload remote URLs, invent paths, or invoke this skill speculatively. If the request contains no local path, return `no-op: no local file path`.

## Upload

Run from this skill's working directory, once per file:

```bash
bash scripts/upload.sh "<file-path>" [owner/repo]
```

- Pass the explicit `owner/repo` when the user supplied one.
- Otherwise the script resolves the repository from `github.repo` config, then the current checkout's `origin` remote.
- The script is non-interactive, prints one asset URL on stdout, and prints an actionable error on stderr when it fails.
- Do not batch files into one invocation. If one upload fails, report that file's exact error and do not claim it uploaded.

## Return markdown

For each successful upload:

- Images: `![filename](asset-url)`
- Videos: put the asset URL on its own line so GitHub renders it.

Return only the markdown-ready results plus any per-file failures the user needs to act on.
