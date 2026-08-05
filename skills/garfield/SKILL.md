---
name: garfield
description: Run the Junior-repo Garfield review-fix-verify loop end-to-end after a meaningful implementation slice. Use when the user explicitly asks to run Garfield, harden a slice, or finish a change with multi-lane review before handoff. Do not use for standalone PR review requests, brainstorming, CI-only iteration, or skill authoring.
disable-model-invocation: true
---

# Garfield (Junior dev)

Own the full loop. The user should only say "run garfield" (optionally with a goal). Do **not** ask them to fill findings files, approve Swamp gates, or run multi-step manual resume commands.

This is **repository development tooling**, not Junior product runtime.

## One-command contract

From the Junior monorepo root:

```bash
node scripts/garfield/run.mjs --goal '<slice goal>'
# ...you review, fix, write findings...
node scripts/garfield/run.mjs --finalize --run-dir <runDir from prepare>
```

Or finalize the latest prepare via the pointer:

```bash
node scripts/garfield/run.mjs --finalize
```

Optional flags on prepare: `--non-goal '...'` (repeatable), `--base <ref>`, `--profile full` (include every source-app policy lane; default is `core`).

## Required procedure

1. **Frame the slice**
   - Infer goal from the user request + current dirty/committed diff if they did not spell one out.
   - State non-goals when obvious (no product-runtime changes, no drive-by refactors, etc.).
2. **Prepare (deterministic)**
   - Run `node scripts/garfield/run.mjs --goal '...'` (add non-goals/base/profile as needed).
   - Read the printed `runDir` and `agent-brief.md`. That brief is authoritative for this run.
3. **Review every applicable lane yourself**
   - Work the lane queue from `agent-todo.json` / `agent-brief.md`.
   - For each lane: read only that lane's `prompts/<lane>.md` plus the card/policy it names and the relevant changed files.
   - Native cards live in `skills/garfield/references/`. Source-app policies live in `policies/`.
   - Write the matching `findings/<lane>.txt` with exactly `none` or Garfield finding lines.
   - Prefer serial review when alone. At most three conceptual lanes in flight.
4. **Merge + triage**
   - Run `node scripts/garfield/merge-findings.mjs --run-dir <runDir>` (or go straight to finalize after findings are written).
   - Treat findings as advice. Cluster by locator + concern. Accept blocker/high when the smallest fix preserves intent. Defer pre-existing debt and intent-expanding work.
5. **Repair**
   - Apply only the smallest accepted fixes to current-diff defects.
   - Re-review only lanes affected by the repair delta; update their findings files.
6. **Finalize (deterministic)**
   - `node scripts/garfield/run.mjs --finalize --run-dir <runDir>`
   - This merges (if needed path), runs targeted validation, and writes `report.md` / `report.json`.
   - Fix required validation failures, then finalize again.
7. **Handoff**
   - Reply with:
     - `garfield: pass` or `garfield: blocked`
     - validation commands/results
     - residual accepted/deferred blocker/high/medium concerns
     - deferred adjacent improvements
   - Omit cycle logs and low-severity bookkeeping.

## Finding format

```text
[severity][evidence:<label[,label]> <locator>;cause:introduced|worsened|stale|missing-required] path:line - concern. impact: <impact>. fix: <smallest change>.
```

If no findings for a lane: exactly `none`.

Evidence labels: `direct`, `spec`, `policy`, `test`, `validation`, `missing`, `inferred`. Never accept `inferred` alone as a blocker.

## Profiles

- `core` (default): always-on lanes + matched native lanes. Source-app policies are skipped and covered by the repository-instructions lane. Cheaper default for agent loops.
- `full`: also opens one lane per `policies/*.md` file.

## Stop conditions

- **pass:** no blocker/high left, required validation passes, report is `garfield: pass`
- **blocked:** same concern twice, three cycles without material progress, needs clarification, or the fix would expand core intent

## What not to do

- Do not stop after prepare and hand the user a manual findings checklist.
- Do not use the Swamp `await-findings` approve/resume path unless the user explicitly wants the human-gated workflow.
- Do not spawn product-runtime Junior jobs; this skill runs local scripts in the checkout.
- Do not expand scope into unrelated cleanup, API changes, or speculative hardening.

## References

| Need | Read |
| --- | --- |
| Native lane cards | [references/review-lanes.md](references/review-lanes.md) |
| Code comments | [references/code-comments.md](references/code-comments.md) |
| Implementation minimalism | [references/implementation-minimalism.md](references/implementation-minimalism.md) |
| Interface design | [references/interface-design.md](references/interface-design.md) |
| Test quality | [references/test-quality.md](references/test-quality.md) |
| Script/workflow details | `swamp/README.md` |
