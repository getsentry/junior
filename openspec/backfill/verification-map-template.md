# Verification Map: `<capability-name>`

| Capability          | Requirement | Scenario | Primary Layer                           | Current Coverage | Action                                    | Gap | Notes |
| ------------------- | ----------- | -------- | --------------------------------------- | ---------------- | ----------------------------------------- | --- | ----- |
| `<capability-name>` |             |          | unit/integration/eval/manual/unverified |                  | keep/rename/split/move/replace/delete/add |     |       |

## Layer Rules

- Use `unit` for local deterministic logic such as parsing, pure transforms, scoring, and schema validation.
- Use `integration` for runtime/product behavior with real wiring, Slack-facing behavior, persistence, routing, auth resume, queueing, or API contracts.
- Use `eval` for model interpretation, prompt-following, natural-language routing, reply quality, and tool-choice judgment.
- Use `manual` only when automated coverage is impractical and the worksheet explains why.
- Use `unverified` only with an explicit deferral reason and follow-up task.

## Coverage Action Meanings

- `keep`: Current test/eval covers the scenario with the right scope and name.
- `rename`: Coverage is right, but taxonomy/name is misleading.
- `split`: File or case mixes multiple capabilities and should be separated.
- `move`: Coverage belongs in a different layer or package.
- `replace`: Existing coverage is low-fidelity or asserts the wrong contract.
- `delete`: Existing coverage duplicates another stronger check or asserts non-contract internals.
- `add`: No current coverage exists.
