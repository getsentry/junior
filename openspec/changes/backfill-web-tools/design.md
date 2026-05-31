# Design: `web-tools`

## Scope

`web-tools` owns model-callable public web search, direct public URL fetch/extraction, and image generation. It starts at a web tool call and ends when the tool returns normalized model-visible results or generated files to hooks.

It does not own generic tool wrapping, final Slack file delivery, Slack upload mechanics, or general prompt policy beyond tool-use boundaries.

## External Prior Art

- Vercel AI Gateway documents Parallel Search as an AI Gateway web-search tool usable through the AI SDK Gateway provider.
- Vercel AI Gateway documents image generation through Chat Completions with a `modalities` parameter and image-capable models, returning image data in the assistant message image array.
- AI Gateway image examples use `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` as credentials.

Sources:

- Vercel AI Gateway web search: https://vercel.com/docs/ai-gateway/web-search
- Vercel AI Gateway image generation: https://vercel.com/docs/ai-gateway/image-generation/openai
- Vercel OpenAI-compatible image generation: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-compat/image-generation

## Design Decisions

### Separate discovery from direct inspection

`webSearch` is for finding source candidates. `webFetch` is for inspecting a known URL. The model should not use search when a user provided the page to inspect, and should not use fetch for broad discovery.

### Treat public-web fetch as security-sensitive

`webFetch` must validate URL scheme and resolved addresses, block local/private targets, pin DNS resolution for the request, and revalidate redirects. This is a repo-owned SSRF boundary, not delegated to provider tooling.

### Keep fetched content bounded and readable

HTML becomes markdown-like text, JSON is pretty-printed, XML/text is normalized, and all extraction is bounded by byte and character budgets. Unsupported content types fail unless the response is an image that can be attached as a generated file.

### Generated image delivery is two-step

`imageGenerate` produces image files and returns attachment paths. The final Slack-visible attachment still requires reply planning or `attachFile`; image generation itself should not claim Slack upload happened.

### Current failure shape is mixed

`webSearch` and `webFetch` currently return `{ ok:false }` results for failures, while `imageGenerate` throws for missing credentials and API errors. This backfill records current behavior and flags alignment with `tool-execution` expected-error policy.

## Risks

- Vercel AI Gateway web-search/tool API shape may change; local tests mock AI SDK calls but do not hit Gateway live.
- Public URL validation can regress in subtle DNS/IPv6/redirect cases.
- Fetching images through `webFetch` emits files to reply hooks, which can surprise reply planning if text is absent.
- Image generation returns zero images as `ok:true`; product behavior for that case is not clearly specified.

## Open Questions

1. Should `webSearch`/`webFetch` failures become expected thrown tool errors instead of `{ ok:false }` tool results?
2. Should zero generated images be `ok:false` or a successful empty generation?
3. Should web search results require citation/source fields beyond title URL snippet?
4. Should `webFetch` support PDFs or other binary documents through a parser instead of failing unsupported content types?
