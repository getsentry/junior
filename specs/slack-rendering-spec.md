# Slack Output Contract

## Metadata

- Created: 2026-04-17
- Last Edited: 2026-04-19

## Changelog

- 2026-04-17: Initial draft of the render-intent layer, plugin renderer registry, and Work Object boundary for Slack delivery.
- 2026-04-17: Dropped Work Objects. Replaced the declarative plugin-template registry with a native-intent palette the model selects from; plugins now teach intent usage through SKILL.md rather than YAML templates.
- 2026-04-17: Added the Intent Delivery Mechanism section (ToolStrategy via the native `reply` tool, Renderer pattern).
- 2026-04-17: Removed the render-intent palette, the `reply` tool, and the plugin recipe layer. The spec now documents a single output contract: the final assistant reply is plain Slack `mrkdwn` text, and the prompt's job is to teach the model which `mrkdwn` features Slack actually renders. A structured-layout palette may return later if there is a concrete product reason to spend model tool-budget on presentation.
- 2026-04-18: Added deterministic output normalization for the most common CommonMark/GFM failure modes (`**bold**`, `~~strike~~`, markdown links, headings, simple pipe tables, wrapped raw URLs) in `chat/slack/mrkdwn.ts`, and moved verification away from prompt-string assertions toward formatter unit coverage plus behavior evals.
- 2026-04-19: Added control-character escaping for literal Slack text (`&`, `<`, `>`), standardized the raw-Web-API reply envelope on section/context blocks with `expand`, and allowed the raw-Web-API reply path to upgrade a single simple markdown table into a native Slack table block while keeping top-level text fallbacks.

## Status

Draft

## Purpose

Define the canonical output contract between Junior's assistant turns and Slack delivery so every visible reply is well-formed Slack `mrkdwn` that Slack actually renders.

Slack's `mrkdwn` is a strict, smaller syntax than CommonMark or GitHub-Flavored Markdown. CommonMark features that Slack silently ignores — pipe tables, `**bold**`, `[label](url)`, `##` headings — render as literal characters and degrade the reply. The output contract names the allow-list the model may use, forbids the CommonMark/GFM constructs that Slack does not support, and applies a small deterministic repair layer for the highest-frequency failure modes before the final reply is delivered.

This spec sits in front of `slack-agent-delivery-spec.md` (reply delivery semantics) and `slack-outbound-contract-spec.md` (outbound Slack API safety). It does not change either of those contracts.

## Scope

- The Slack `mrkdwn` syntax the model is allowed to emit in a final reply.
- The CommonMark/GFM constructs the model must not emit because Slack does not render them.
- How the prompt teaches these rules (a single `<output surface="slack" ...>` section).
- The targeted deterministic repairs that the Slack output boundary applies before delivery.

## Non-Goals

- Replacing the visible reply delivery contract defined in `slack-agent-delivery-spec.md`.
- Replacing the outbound boundary defined in `slack-outbound-contract-spec.md`.
- Introducing a render-intent palette, a `reply` tool, or any other structured-layout mechanism. Revisit if there is a concrete product reason to spend model tool-budget on layout.
- Letting the model author Slack Block Kit blocks directly.
- Specifying chart or image-generation surfaces. Slack still receives those as image attachments with a concise textual takeaway.

## Contracts

### 1. Output form

Every final assistant reply still has a plain-text Slack fallback. The model never authors blocks and never emits raw JSON.

When Junior has a concrete Slack thread target, the shared raw-Web-API reply planner attaches a shared reply envelope around that fallback text:

- a `section` block for each visible text post, with `expand: true`
- an optional `context` block for diagnostic footer metadata on the final text post
- when the finalized reply fits in one post and the original source text contains one simple markdown pipe table, a native Slack `table` block may replace the ASCII-table body rendering while the top-level fallback text remains the normalized `mrkdwn` string

### 2. Allowed Slack `mrkdwn`

The prompt explicitly permits the following syntax. Anything not on this allow-list renders as literal characters.

- `*bold*` — surround with single asterisks. Slack does not render `**bold**`.
- `_italic_` — surround with single underscores.
- `~strike~` — surround with single tildes. Slack does not render `~~strike~~`.
- `` `inline code` `` and triple-backtick fenced code blocks.
- `> quoted text` at the start of a line for block quotes. A blank line ends the quote.
- `<https://example.com|Label>` for hyperlinks with a label. A bare `https://example.com` auto-links without a label. Slack does not render `[Label](https://example.com)`.
- `<@USERID>`, `<#CHANNELID>`, `<!subteam^TEAMID>` for user, channel, and group mentions. The model uses the raw IDs provided elsewhere in the prompt.
- `- item` or `* item` at the start of a line for bullet lists. Numbered lists render but indent awkwardly — prefer bullets.
- A bold label on its own line (`*Section*`) in place of a markdown heading.

### 3. Forbidden constructs

The prompt explicitly forbids the following because Slack renders them as literal characters or broken formatting.

- Markdown tables using pipes and dashes (`| col | col |` / `|---|---|`). Slack renders the pipes verbatim. When tabular data is needed, the model uses short bulleted lists grouped by row, or a fenced code block with manually aligned columns.
- Markdown headings (`#`, `##`, `###`, and so on). Use a bold label on its own line instead.
- Markdown link syntax (`[label](url)`). Rewrite as `<url|label>` or a bare URL.
- CommonMark bold/strike doubles (`**bold**`, `~~strike~~`). Use the single-delimiter forms.
- HTML tags, image embeds, and raw Slack Block Kit JSON.

### 4. Prompt surface

These rules live in one place: the `<output surface="slack" ...>` section built by `buildSlackOutputContract` in `packages/junior/src/chat/prompt.ts`. The section is the sole authority on what a Slack response may contain. Plugin `SKILL.md` content describes domain behavior (what to fetch, how to phrase a ticket) but does not restate or override these syntax rules.

The section also carries the other per-reply guidance this surface requires: brevity, no initial-acknowledgement for tool-heavy research, no progress narration, one final reply per turn.

### 5. Deterministic normalization

The output boundary applies a targeted normalization pass in `packages/junior/src/chat/slack/mrkdwn.ts` before reply chunking and delivery. This pass is intentionally narrow and conservative:

- `**bold**` is rewritten to `*bold*`.
- `~~strike~~` is rewritten to `~strike~`.
- `[label](url)` is rewritten to `<url|label>`.
- Markdown headings (`## Summary`) are rewritten to bold section labels (`*Summary*`).
- Simple markdown pipe tables are rewritten as fenced code blocks with aligned columns so Slack renders them safely.
- Raw URLs that are directly wrapped in formatting delimiters are rewritten to Slack link syntax so formatting characters do not bleed into the URL.
- Literal `&`, `<`, and `>` characters in prose are escaped unless they are part of preserved Slack tokens (`<@U...>`, `<#C...>`, `<!...>`, links) or a block-quote marker.

Code spans and fenced code blocks are preserved verbatim. The normalizer does not promise full CommonMark-to-Slack conversion; unsupported complex structures are still a prompt-quality issue.

## Failure Model

1. The model emits a common forbidden construct (`**bold**`, `~~strike~~`, `[label](url)`, `##` heading, simple pipe table). The deterministic normalizer repairs it before delivery.
2. The model emits a more complex unsupported structure that the normalizer does not recognize. Slack may still render it poorly; that is a prompt-quality failure, and the fix usually lives in the `<output>` section plus a behavior eval.
3. The model emits a correct `mrkdwn` construct that exceeds the envelope's length cap. The outbound boundary truncates or chunks per `slack-outbound-contract-spec.md`. No change here.
4. The model tries to author blocks or JSON directly. The prompt forbids it; if it slips through, the outbound boundary treats the raw string as text and the visible output degrades.

## Verification

Required verification coverage for this contract:

1. Unit: the deterministic formatter in `chat/slack/mrkdwn.ts` repairs the known high-frequency CommonMark/GFM failure modes and preserves code spans / code fences.
2. Unit/integration: the raw-Web-API reply path emits section/context blocks with top-level text fallbacks and upgrades a single simple markdown table to a native Slack table block when source text is available.
3. Evals: realistic Slack conversations confirm the final visible reply does not contain unsupported constructs (raw pipe tables, `**bold**`, `[label](url)`, `##` headings) even when the user asks for a comparison, a heading, or a link.

## Related Specs

- `./slack-agent-delivery-spec.md`
- `./slack-outbound-contract-spec.md`
- `./chat-architecture-spec.md`
- `./plugin-spec.md`
- `./logging/index.md`
- `./testing/index.md`
