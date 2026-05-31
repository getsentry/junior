# Backfill `web-tools`

## Why

Junior's web tools are the agent's public-web discovery, direct URL inspection, and generated-image surface. They combine Vercel AI Gateway search/image APIs, custom public-URL fetch safeguards, content extraction, generated-file handoff, and current-data/source-use behavior. These contracts need a dedicated baseline instead of being inferred from prompt prose, tool code, and scattered tests.

## What Changes

- Add an OpenSpec capability for `web-tools`.
- Specify `webSearch`, `webFetch`, and `imageGenerate` behavior.
- Specify public URL safety, redirect/DNS pinning, content extraction, truncation, image fetch attachment, search result normalization, image prompt enrichment, and generated image handoff.
- Record provider prior art from Vercel AI Gateway docs and current implementation gaps.
- Map current tests/evals and verification follow-ups.

## Impact

- Affected specs:
  - `tool-execution`
  - `security-policy`
  - `reply-planning`
  - `attachment-and-vision-context`
  - `agent-prompt`
  - `eval-testing`
  - `testing`
- Affected code evidence:
  - `packages/junior/src/chat/tools/web/search.ts`
  - `packages/junior/src/chat/tools/web/fetch-tool.ts`
  - `packages/junior/src/chat/tools/web/fetch-content.ts`
  - `packages/junior/src/chat/tools/web/network.ts`
  - `packages/junior/src/chat/tools/web/image-generate.ts`
- Affected verification:
  - Unit tests for search mapping, fetch conversion/safety, image generation request/response parsing, and timeouts.
  - Evals for research answer shape, source use, current-data behavior, and generated image user workflow.
