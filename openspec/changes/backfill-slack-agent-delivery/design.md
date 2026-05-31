## Context

`specs/slack-agent-delivery.md` already describes the intended Slack delivery contract in detail. The backfill goal is not to replace that document yet; it is to create an OpenSpec baseline capability that is easier to validate, task, and later archive into `openspec/specs/`.

Slack prior art constrains several parts of the contract:

- Slack assistant apps receive `assistant_thread_started` and `assistant_thread_context_changed` lifecycle events, and Slack's Assistant guidance treats thread context as something apps may store themselves instead of repeatedly refetching from Slack history.
- `assistant.threads.setStatus` accepts `channel_id`, `thread_ts`, `status`, and optional `loading_messages`; Slack clears status when a reply arrives or when an empty status is sent.
- `chat.postMessage` uses `thread_ts` for thread replies, recommends a top-level `text` fallback when blocks are used, and truncates very long text.
- Slack's legacy `files.upload` is sunset, while the current code uses `filesUploadV2` / external upload flow through the Slack SDK wrapper. The delivery spec should describe file delivery semantics, not bind product behavior to the legacy method name.

## Goals / Non-Goals

**Goals:**

- Define Slack delivery as one capability with scenario-level OpenSpec requirements.
- Preserve existing canonical behavior from `specs/slack-agent-delivery.md` while separating behavior contracts from transport implementation details.
- Record which clauses are verified today versus only documented or inferred.
- Keep Slack delivery scoped to user-visible Slack behavior and link to adjacent specs for routing, outbound API validation, prompt quality, resumability records, and testing governance.

**Non-Goals:**

- Implementing missing tests or runtime behavior in this change.
- Freezing exact Slack copy where the product contract only needs durable semantics.
- Re-specifying Slack outbound validation covered by `slack-outbound-contract`.
- Re-specifying model reply quality, eval rubrics, OAuth provider security, or Pi session storage internals.

## Decisions

### Decision: Keep finalized thread replies as the primary visible artifact

Junior should continue to post visible assistant text only after final reply planning. This matches the implemented `reply-executor.ts` and `slack/reply.ts` flow: provisional model deltas are ignored for Slack-visible delivery, final replies are chunked and delivered through the Slack output path, and turn success waits for final Slack delivery.

Alternatives considered:

- Make Slack-native streaming part of correctness: rejected because current code and specs intentionally use assistant status for in-flight progress and finalized posts for durable content.
- Allow provisional text updates: rejected for now because it would change persistence, interruption, and resume semantics.

### Decision: Treat assistant status as progress UX, not reply delivery

Slack's status API is best suited for transient progress: Slack documents automatic clearing on reply and explicit clearing with empty status. Junior's contract should keep status best effort, token-bound, non-blocking, and separate from finalized reply footers.

Alternatives considered:

- Treat status failure as turn failure: rejected because it is not the user's durable answer.
- Encode detailed diagnostics in status: rejected because status is transient and bounded; final footer metadata belongs to the final reply artifact.

### Decision: Specify file/image behavior by product semantics

The current code delivers files via `uploadFilesToThread` and `filesUploadV2`, while Slack's old `files.upload` API is deprecated. The OpenSpec requirement should say that files must be delivered in the thread according to the reply plan and that inbound images must survive normalization/hydration; the exact Slack upload primitive belongs to `slack-outbound-contract`.

Alternatives considered:

- Name `files.upload` in the delivery capability: rejected because it would bake a deprecated Slack method into the product contract.
- Move file delivery entirely to outbound: rejected because file-only replies and resume file behavior are user-visible delivery decisions.

### Decision: Keep coverage mapping behavior-first

Existing tests are valuable but not always scoped to the ideal taxonomy. The verification map classifies cases as keep, rename, split, or add without editing them in this change.

Alternatives considered:

- Rename/split tests during spec backfill: rejected because the user requested spec work only.
- Claim all clauses verified because similarly named Slack tests exist: rejected because some clauses are documented intent or indirectly covered.

## Risks / Trade-offs

- [Risk] OpenSpec diverges from `specs/slack-agent-delivery.md`. Mitigation: keep this change as a backfill, then align the canonical markdown spec and index when accepted.
- [Risk] Current bugs become normative. Mitigation: keep open questions explicit where code/test evidence is weak.
- [Risk] Requirements become too transport-specific. Mitigation: push Slack Web API request shape details to `slack-outbound-contract`.
- [Risk] Slack platform behavior changes. Mitigation: cite official docs and keep implementation details like scope migration in verification notes rather than hard product requirements unless Junior depends on them.

## Open Questions

- Should exact assistant status debounce and refresh intervals become normative, or should the contract only require early non-empty status, refresh before expiry, and explicit clear?
- Should footer fields be contractually fixed, or should the contract only require structured final-reply metadata when configured?
- Should file upload verification be renamed from legacy file-upload terminology to current external-upload semantics everywhere?
- Should `connectedText` in OAuth resume remain a visible public banner, or should automatic auth resumes converge on the canonical "no separate public connected banner" rule?
- Should channel-only replies with files always produce a file-only thread artifact, or should some file side effects be allowed to satisfy delivery entirely outside the thread?

## Migration Plan

1. Validate this OpenSpec change.
2. Review the worksheet and verification map against the existing canonical Slack delivery spec.
3. After acceptance, archive this baseline into `openspec/specs/slack-agent-delivery/spec.md`.
4. Update `specs/slack-agent-delivery.md` only where OpenSpec exposes ambiguity, deprecated method wording, or coverage gaps.
5. Use the verification map to plan follow-up test/eval taxonomy changes without mixing them into this spec-only change.
