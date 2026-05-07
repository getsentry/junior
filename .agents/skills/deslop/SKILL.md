---
name: deslop
description: Simplifies code interfaces and removes codebase slop while preserving behavior. Use when asked to "deslop", "simplify this interface", "remove cruft", "clean up comments", or "reduce code slop". Enforces hard guardrails for smaller public surfaces, dead-code removal, and high-signal comments.
---

<!--
Adapted from local code-simplifier prior art:
/home/dcramer/src/sentry-skills/plugins/sentry-skills/skills/code-simplifier/SKILL.md
/home/dcramer/src/sentry-skills/plugins/sentry-skills/agents/code-simplifier.md
-->

Deslop code by shrinking interfaces, deleting cruft, and clarifying comments without changing behavior.

## Step 1: Classify the slop to remove

Choose one or more categories before editing:

| Category | Typical signals | Reference |
| --- | --- | --- |
| Interface bloat | Too many exports, broad parameter objects, weak contracts | `${CLAUDE_SKILL_ROOT}/references/interface-simplicity.md` |
| Structural cruft | Dead code, stale flags, redundant adapters/helpers | `${CLAUDE_SKILL_ROOT}/references/cruft-removal.md` |
| Comment slop | Comments restate code, stale comments, inconsistent terms | `${CLAUDE_SKILL_ROOT}/references/comment-clarity.md` |

If multiple categories apply, read only those references.

## Step 2: Lock invariants

Before making changes, state and preserve these invariants:

1. Runtime behavior and externally visible outputs stay equivalent unless the user explicitly requests behavior changes.
2. Public interfaces get smaller or clearer, never broader without a concrete requirement.
3. New abstractions must prove reuse value; otherwise prefer direct composition.

## Step 3: Apply hard guardrails

1. Remove dead code when usage is absent or obsolete by contract.
2. Collapse redundant wrappers/adapters that add indirection without value.
3. Reduce exported surface area and tighten types/contracts at the consumer boundary.
4. Replace dense cleverness with explicit control flow when readability improves.
5. Delete or rewrite comments that narrate obvious code; keep comments that explain intent, constraints, and non-obvious tradeoffs.
6. Keep terminology consistent across APIs, types, and comments.

## Step 4: Verify behavior safety

1. Run targeted tests for touched areas.
2. Run typecheck or static checks relevant to the changes.
3. If behavior might have shifted, call it out explicitly and stop for user confirmation before widening scope.

## Step 5: Report anti-slop delta

Return a concise summary with these sections:

1. `Interface reductions` — removed/renamed exports, narrowed contracts.
2. `Cruft removals` — dead code and obsolete indirection deleted.
3. `Comment cleanups` — what was removed or rewritten and why.
4. `Behavior-safety checks` — tests/checks run and outcome.
5. `Residual risks` — any uncertainty or follow-up checks.

## Exit Criteria

- Public surface area is smaller or clearer for the touched scope.
- Confirmed dead code in scope is removed.
- Remaining comments add non-obvious value.
- Verification evidence is provided.
