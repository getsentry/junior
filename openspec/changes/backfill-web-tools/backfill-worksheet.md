# Backfill Worksheet: `web-tools`

## Scope

- Capability: Web tools
- Change: `backfill-web-tools`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/web-tools/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/tool-execution.md`: shared tool wrapping and expected failure policy.
- `specs/security-policy.md`: public-network and private data constraints.
- `specs/reply-planning.md`: generated file visibility and final Slack delivery.
- `specs/attachment-and-vision-context.md`: image/file context boundaries.
- `specs/agent-prompt.md`: source hierarchy, current-data, and citation prompt policy.
- `specs/eval-testing.md`: eval ownership for model-facing source behavior.
- `specs/testing.md`: unit/integration/eval layer boundaries.

### Code Paths

- `packages/junior/src/chat/tools/web/search.ts`: AI Gateway Parallel Search wrapper, pinned default search model, result normalization, timeout/abort behavior, auth failure classification.
- `packages/junior/src/chat/tools/web/fetch-tool.ts`: public URL validation, redirect fetch, image attachment handoff, fetch failure shape.
- `packages/junior/src/chat/tools/web/network.ts`: SSRF protections, DNS resolution, private IP blocking, pinned lookup, manual redirects, timeout helper.
- `packages/junior/src/chat/tools/web/fetch-content.ts`: HTML/JSON/text/XML extraction, main/article preference, title extraction, truncation, content-type and byte limits.
- `packages/junior/src/chat/tools/web/image-generate.ts`: prompt enrichment, Gateway chat completions image generation, response image parsing, generated artifact file hooks.
- `packages/junior/src/chat/tools/web/constants.ts`: user agent, timeouts, redirects, byte and character budgets.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/web/web-search.test.ts`
  - `packages/junior/tests/unit/web-fetch-tool.test.ts`
  - `packages/junior/tests/unit/web/web-fetch-convert.test.ts`
  - `packages/junior/tests/unit/web/image-generate.test.ts`
- Evals:
  - `packages/junior-evals/evals/core/research-reply-shape.eval.ts`
  - Source-handbook fixture eval materials.
  - Image-generate fixtures.

## Prior Art

- Vercel AI Gateway exposes Parallel Search as a web search tool through AI Gateway/AI SDK.
- Vercel AI Gateway supports image generation through Chat Completions with image-capable models and `modalities`.
- Gateway image generation examples use `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`.
- SSRF defense for arbitrary URL fetches is a local product/security responsibility.

Sources:

- Vercel AI Gateway web search: https://vercel.com/docs/ai-gateway/web-search
- Vercel AI Gateway image generation: https://vercel.com/docs/ai-gateway/image-generation/openai
- Vercel OpenAI-compatible image generation: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-compat/image-generation

## Implemented Behavior

- Behavior that code currently enforces:
  - `webSearch` uses AI Gateway provider tools with pinned default search model and forced `parallelSearch` tool choice.
  - Search returns at most five title/URL/snippet results.
  - Search timeout aborts generation and returns retryable `ok:false`.
  - Search auth failures are non-retryable `ok:false`.
  - `webFetch` accepts only public HTTP(S) URLs, blocks local/private hosts and addresses, revalidates redirects, and limits redirects.
  - Fetch extraction supports HTML to markdown, JSON pretty-printing, text/XML normalization, main/article preference, titles, byte budgets, and character truncation.
  - Fetch image responses within byte budget become generated files for reply attachment.
  - `imageGenerate` requires Gateway credentials, enriches prompts using the fast model, calls AI Gateway chat completions with `modalities: ["image"]`, parses data/remote image URLs, and emits generated artifact files.
  - Image generation returns attachment paths and does not claim Slack upload occurred.
- Behavior that tests currently verify:
  - Gateway search tool invocation, default model pinning, error wrapping, timeout aborts, and non-retryable auth failures.
  - Basic fetch-tool delegation for non-image responses.
  - HTML/JSON extraction, main content preference, title entity handling, nested articles, large document truncation.
  - Image generation default/configured model, prompt enrichment fallback, image response parsing, and model-not-image actionable error.
- Behavior that appears accidental or weakly enforced:
  - SSRF redirect/DNS edge cases likely need more direct tests.
  - Fetch image attachment path needs focused coverage if not already present.
  - `webSearch`/`webFetch` failure results conflict with strict `ToolInputError` policy for repairable failures.
  - Zero generated images currently returns success with `image_count: 0`.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Use search for discovery and fetch for known URLs.
  - Never fetch local/private network targets.
  - Keep web results bounded and source-addressable.
  - Make generated/fetched images available through file hooks, not implicit Slack uploads.
  - Use Gateway credentials and image-capable models for image generation.
- Behavior that should remain implementation detail:
  - Exact default model IDs.
  - Exact extraction/truncation thresholds unless product fixes them.
  - Exact HTML-to-markdown library.
  - Exact search provider internals behind Gateway.
- Behavior that should be non-goal:
  - Full browser rendering or JavaScript execution.
  - PDF/document parsing until explicitly added.
  - Source citation prose in final answer.
  - Slack upload mechanics.

## Undefined Behavior / Open Questions

| Question                                          | Evidence                                                                                 | Options                                                                 | Recommendation                                                               | Status |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| Should web failures throw expected tool errors?   | Current search/fetch return `ok:false`; tool-execution prefers thrown repairable errors. | Convert all, keep read failures as data, or split security/auth/system. | Review after tool-family audit.                                              | open   |
| Should zero image outputs be failure?             | Image generation returns `ok:true` with `image_count: 0`.                                | Success empty, `ok:false`, or thrown provider error.                    | Treat as failure after product review unless provider has valid empty cases. | open   |
| Should fetch support PDFs?                        | Current fetch rejects unsupported binary except images.                                  | Add PDF extractor, attach PDFs, or keep unsupported.                    | Keep unsupported until parser/security story exists.                         | open   |
| Where do citation requirements belong?            | Prompt/evals own final answer shape; web tools return URL fields.                        | Web-tools, agent-prompt/evals, or split.                                | Split: URLs here; answer citations in prompt/evals.                          | open   |
| Should live Gateway checks be part of validation? | Unit tests mock provider APIs.                                                           | Optional credentialed integration, eval, or no live check.              | Optional, credential-gated integration/eval.                                 | open   |

## OpenSpec Requirements Draft

| Requirement                      | Scenarios                                                              | Source Evidence                   | Notes                       |
| -------------------------------- | ---------------------------------------------------------------------- | --------------------------------- | --------------------------- |
| Web tool separation              | discovery, URL, image                                                  | tool descriptions/prompt          | Tool-choice eval elsewhere. |
| Web search through Gateway       | success, default model, timeout, auth                                  | search code/tests, Vercel docs    | Provider path.              |
| Public URL fetch safety          | scheme, private host/address, redirect, limit                          | network code                      | Security critical.          |
| Web fetch extraction             | HTML, JSON, text/XML, bytes, unsupported                               | fetch-content/tests               | Deterministic.              |
| Web fetch image attachment       | image success, oversize                                                | fetch-tool                        | File hook bridge.           |
| Image generation through Gateway | credentials, enrichment, fallback, data/URL images, bad model, success | image-generate/tests, Vercel docs | Generated file bridge.      |
| Verification taxonomy            | unit, provider, eval                                                   | testing spec                      | Live checks gated.          |

## Migration Notes

- Canonical spec updates:
  - Add `web-tools` to index after acceptance.
  - Keep source-answer quality in prompt/eval specs.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Do not duplicate SSRF rules in prompt docs; link to this capability/security policy.
- Test/eval taxonomy changes:
  - Map research/source evals to prompt/eval capabilities while keeping deterministic web tool tests here.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-web-tools' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: web failure error-shape policy, zero-image result policy, SSRF redirect/DNS edge coverage, PDF support decision, and live Gateway checks.
