# Bug Issue Rules

Use this file only when issue type is `bug`.

## Primary Goal

Produce a high-signal bug issue that drives root-cause discovery, not premature solutioning.

## Required Research Shape

1. Capture concrete evidence:
- reproducible steps or explicit non-repro statement
- exact error or symptom
- impacted surface and scope

2. Build a timeline with exact dates when known:
- first observed
- known regressions or relevant deploy/release windows

3. Separate known from unknown:
- `Verified Facts` contain only directly supported claims
- unknown details stay in `Unknowns`

4. Form root-cause hypotheses:
- each hypothesis must link back to evidence
- include confidence (`high`, `medium`, `low`)

## Fix Guidance

- You may include tentative fix options.
- Label options as tentative unless root cause is directly evidenced.
- If root cause is not verified, include `RCA Next Steps` before or alongside fix options.
- Do not present one fix as certain without explicit evidence.

## Completion Bar

A `bug` issue is ready when it has:
- clear symptom and scope
- evidence-backed facts
- explicit unknowns
- root-cause hypotheses with confidence
- testable acceptance criteria
