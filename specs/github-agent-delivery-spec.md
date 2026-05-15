# GitHub Agent Delivery Spec

## Metadata

- Created: 2026-05-16
- Last Edited: 2026-05-16

## Changelog

- 2026-05-16: Initial canonical contract for GitHub mention-based entry surfaces, one-turn delivery semantics, and V1 platform/tool boundaries.

## Status

Active

## Purpose

Define the canonical user-visible GitHub delivery contract for Junior V1:

- which GitHub webhook comment surfaces can start a turn
- when a GitHub comment should and should not trigger work
- how final GitHub replies are delivered and formatted
- how GitHub turns differ from Slack turns for tools and prompt instructions

## Scope

- GitHub App webhook ingress through `/api/webhooks/github`
- Mention-only V1 behavior on issue comments, PR conversation comments, and PR review comments
- Final GitHub comment reply semantics for a single turn
- GitHub-flavored markdown output expectations
- GitHub turn tool-profile constraints and Slack isolation
- Retry, dedupe, and self-message handling needed for safe comment delivery

## Non-Goals

- Responding to untagged comments
- Event-driven autonomous behaviors (`issues.opened`, `pull_request.opened`, label changes, review requested)
- Streaming partial assistant text, typing/status indicators, or progressive comment edits
- GitHub DMs, slash commands, app-home style UX, file upload workflows, or Slack-style channel posting features
- Building a generic event-rule engine

## Contracts

### 1. Supported V1 Entry Surfaces

Junior supports GitHub mentions only from these webhook-backed comment surfaces:

1. `issue_comment` on issues.
2. `issue_comment` on pull requests (conversation tab comments).
3. `pull_request_review_comment` on review threads (files changed comments).

Any other GitHub webhook event is out of contract for V1 unless it carries one of the above comment mentions and adapter routing normalizes it to the same mention path.

### 2. Mention-Only Trigger Contract

V1 execution is explicit mention only.

1. A turn starts only when Junior is explicitly tagged in the GitHub comment body.
2. Untagged comments do not start work.
3. Subscribed-thread or passive follow-up behavior must not cause GitHub replies without a fresh explicit mention.
4. Self-authored comments from Junior must not trigger new turns.

### 3. One-Turn Delivery Contract

For each valid explicit mention, Junior executes one turn and posts one final visible GitHub comment reply.

1. The visible user-facing artifact for V1 is a finalized GitHub comment.
2. V1 does not stream partial text or expose in-flight status surfaces.
3. Delivery success is defined by accepted final GitHub comment creation in the correct target thread context.
4. If generation fails, Junior posts a GitHub-safe fallback error comment.

### 4. Markdown Contract

GitHub turns use GitHub-flavored markdown (GFM) as the output contract.

1. Output instructions must target GitHub comment readability.
2. Slack-specific markdown guidance and Slack action guidance must not be applied to GitHub turns.
3. Runtime/prompt metadata should declare GitHub output format explicitly rather than inferring from thread IDs.

### 5. Tool Profile Contract

GitHub turns run with a GitHub-safe tool profile.

1. Core tools remain available (sandbox, web, MCP/provider, and runtime-safe helpers).
2. Slack-only side-effect tools are excluded from GitHub turns.
3. Tool selection must be explicit via a surface/tool-profile contract, not implicit Slack channel capability checks.

### 6. Retry, Dedupe, and Idempotency Contract

GitHub webhook handling and delivery must avoid duplicate work from retried deliveries.

1. Webhook signature verification must gate processing.
2. Duplicate webhook deliveries for the same mention must not result in duplicated assistant turn delivery.
3. Comment delivery should be idempotent at the turn boundary when retries occur.
4. Internal retries may occur for transient provider/network failures, but must preserve single-visible-reply semantics for one mention.

### 7. Future Event-Driven Extension Point

V1 must preserve explicit seams for future autonomous event handling without implementing it now.

Required explicit concepts:

- platform/surface classification
- tool profile selection
- delivery target selection

A future event-trigger runtime may reuse these seams, but event-rule matching and autonomous turn policy remain out of scope for this spec.

## Failure Model

1. Invalid GitHub webhook signature: reject request and do not run a turn.
2. Unsupported or untagged GitHub comment event: acknowledge without delivery side effects.
3. Final GitHub comment delivery failure: treat as turn failure and emit fallback handling where possible.
4. Slack-only tools appearing in GitHub runs: contract violation.
5. Slack behavior regression caused by GitHub path changes: contract violation.

## Observability

GitHub delivery paths must emit enough diagnostics to distinguish:

- webhook authentication/validation failures
- ignored untagged comments vs handled mention comments
- generation failures vs final GitHub comment post failures
- duplicate delivery suppression outcomes

Required attribute families should include platform, repository/thread identifiers, run/turn identifiers, and requester identifiers consistent with logging specs.

## Verification

Required coverage for this contract:

1. Integration: signed `/api/webhooks/github` request reaches mention handling path.
2. Integration: explicit mention in issue comment posts one final GitHub reply.
3. Integration: explicit mention in PR conversation comment posts one final GitHub reply.
4. Integration: explicit mention in PR review comment thread posts reply in correct review thread context.
5. Integration: untagged comments do not trigger agent execution.
6. Integration: GitHub turns do not expose Slack-only tools.
7. Integration: Slack mention behavior remains unchanged.

## Related Specs

- `./chat-architecture-spec.md`
- `./agent-prompt-spec.md`
- `./slack-agent-delivery-spec.md`
- `./testing/index.md`
