## ADDED Requirements

### Requirement: Web tool separation

Junior SHALL expose separate tools for web discovery, direct URL inspection, and image generation.

#### Scenario: Discovery is needed

- **WHEN** the model needs public source candidates or current web discovery
- **THEN** it SHOULD call `webSearch`

#### Scenario: Specific URL is provided

- **WHEN** the user provides a concrete URL to inspect
- **THEN** the model SHOULD call `webFetch` rather than using search as the first step

#### Scenario: User asks to create an image

- **WHEN** the user asks to generate or visually represent something
- **THEN** the model MAY call `imageGenerate`

### Requirement: Web search through Gateway search tool

Junior SHALL perform public web search through the configured AI Gateway search path unless an explicit test override is injected.

#### Scenario: Search succeeds

- **WHEN** AI Gateway returns Parallel Search tool results
- **THEN** Junior SHALL normalize up to the requested result limit into title, URL, and snippet fields

#### Scenario: Search model is unset

- **WHEN** `AI_WEB_SEARCH_MODEL` is unset
- **THEN** Junior SHALL use the pinned search-oriented default model rather than general assistant model settings

#### Scenario: Search times out

- **WHEN** search exceeds the search timeout
- **THEN** Junior SHALL abort the in-flight generation request and return a timeout result marked retryable

#### Scenario: Search authentication fails

- **WHEN** Gateway authentication is missing or rejected
- **THEN** Junior SHALL return a non-retryable search failure result

### Requirement: Public URL fetch safety

Junior SHALL fetch only public HTTP(S) URLs and SHALL defend against private-network fetches.

#### Scenario: URL scheme is not HTTP or HTTPS

- **WHEN** `webFetch` receives a non-HTTP(S) URL
- **THEN** Junior SHALL reject the fetch

#### Scenario: Host is local or private

- **WHEN** a URL host is localhost, private IP, link-local, unique-local, mapped private IPv6, `.local`, or `.internal`
- **THEN** Junior SHALL reject the fetch

#### Scenario: Hostname resolves to private address

- **WHEN** DNS resolution for a hostname returns a private address
- **THEN** Junior SHALL reject the fetch before connecting

#### Scenario: Redirect points to unsafe target

- **WHEN** a fetched URL redirects
- **THEN** Junior SHALL validate the redirected URL before following it

#### Scenario: Redirect chain exceeds limit

- **WHEN** redirects exceed the configured redirect budget
- **THEN** Junior SHALL fail the fetch with a redirect-limit error

### Requirement: Web fetch extraction

Junior SHALL extract bounded readable content from supported public URL responses.

#### Scenario: HTML response is fetched

- **WHEN** a public URL returns HTML
- **THEN** Junior SHALL prefer main/article content when available, convert it to markdown-like text, include title metadata when available, and bound output by character budget

#### Scenario: JSON response is fetched

- **WHEN** a public URL returns JSON
- **THEN** Junior SHALL pretty-print JSON and bound output by character budget

#### Scenario: Text or XML response is fetched

- **WHEN** a public URL returns supported text or XML content
- **THEN** Junior SHALL normalize whitespace and bound output by character budget

#### Scenario: Response body exceeds byte budget

- **WHEN** the response body exceeds the configured byte budget
- **THEN** Junior SHALL fail or truncate according to the extractor boundary rather than reading unbounded data

#### Scenario: Unsupported non-image content type is fetched

- **WHEN** a public URL returns an unsupported non-image content type
- **THEN** Junior SHALL return a fetch failure result

### Requirement: Web fetch image attachment

Junior SHALL treat directly fetched public images as generated files for final reply delivery.

#### Scenario: Image response is fetched

- **WHEN** a public URL returns an image content type within the byte budget
- **THEN** Junior SHALL emit the image bytes through generated-file hooks with a filename and media type
- **AND** Junior SHALL return a tool result that explains the image will be available for Slack reply attachment

#### Scenario: Image response exceeds byte budget

- **WHEN** an image response exceeds the configured byte budget
- **THEN** Junior SHALL fail the fetch rather than emitting an oversized file

### Requirement: Image generation through Gateway

Junior SHALL generate images through AI Gateway chat completions using an image-capable model.

#### Scenario: Gateway credentials are missing

- **WHEN** no Gateway API key or Vercel OIDC token is available
- **THEN** `imageGenerate` SHALL fail before making the image request

#### Scenario: Image prompt enrichment succeeds

- **WHEN** prompt enrichment produces non-empty text
- **THEN** Junior SHALL send the enriched prompt to the image-generation API while preserving the original prompt in tool details

#### Scenario: Image prompt enrichment fails or returns empty

- **WHEN** prompt enrichment fails or returns empty text
- **THEN** Junior SHALL use the raw user prompt for image generation

#### Scenario: Image API returns data URLs or remote image URLs

- **WHEN** the image API returns images as data URLs or fetchable remote URLs
- **THEN** Junior SHALL decode or fetch those images, infer filenames/media types, and emit them through generated-artifact-file hooks

#### Scenario: Configured image model is not image-capable

- **WHEN** the Gateway response indicates the configured model is not an image generation model
- **THEN** Junior SHALL fail with an actionable model-configuration error

#### Scenario: Image generation succeeds

- **WHEN** generated image files are available
- **THEN** Junior SHALL return attachment paths and delivery guidance without claiming Slack upload has already occurred

### Requirement: Web-tools verification taxonomy

Web-tools verification SHALL separate local deterministic safety/extraction behavior from live provider behavior and model-facing source use.

#### Scenario: Local web tool logic is verified

- **WHEN** verifying URL safety, redirects, extraction, truncation, search result mapping, timeout handling, or image response parsing
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Provider integration is verified

- **WHEN** verifying real AI Gateway search or image generation behavior
- **THEN** the primary coverage MAY require integration tests or evals with network and Gateway credentials

#### Scenario: Source-backed answer quality is verified

- **WHEN** verifying citation/source use, current-data decisions, or research answer quality
- **THEN** the primary coverage SHALL be evals owned jointly with `agent-prompt` and eval governance
