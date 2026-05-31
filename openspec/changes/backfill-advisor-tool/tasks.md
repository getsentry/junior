## 1. Source Inventory

- [x] 1.1 Inspect existing advisor prose spec and related execution, tool, prompt, compaction, resumability, instrumentation, and testing specs.
- [x] 1.2 Inspect advisor tool implementation, session store, tool composition, runtime wiring, and config parsing.
- [x] 1.3 Inventory current unit/integration/eval coverage for advisor exposure, config, tool filtering, explicit context, session persistence, and failure behavior.

## 2. Prior Art Review

- [x] 2.1 Review Claude Code subagent docs for context isolation, tool restrictions, delegation, and persistent memory.
- [x] 2.2 Review Claude Agent SDK subagent docs for parent-to-subagent prompt boundaries, explicit context transfer, tool subsets, and resume behavior.
- [x] 2.3 Review Amp Oracle notes for stronger read-only advisor-as-tool behavior in coding agents.

## 3. Spec Authoring

- [x] 3.1 Create the `advisor-tool` OpenSpec requirements and scenarios.
- [x] 3.2 Record undefined behavior and open questions in the worksheet.
- [x] 3.3 Create the verification map with current test/eval mapping and follow-up gaps.

## 4. Validation

- [x] 4.1 Run `openspec validate backfill-advisor-tool`.
- [x] 4.2 Record validation notes and deferred verification.
- [x] 4.3 Mark the baseline tracker item complete after validation passes.
