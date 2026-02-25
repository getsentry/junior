---
name: brief
description: Grade engineering candidates from public technical evidence for non-technical hiring decisions. Use when asked to screen a candidate, referral, or interview target. Review 5-8 technical artifacts across code repositories, collaboration history, portfolio and technical writing, and other public work signals, then report a profile grade (A-F), likely location and hub fit, hiring recommendation, confidence, and interview focus.
---

# Candidate Brief

## Process

1. Identify available public sources (GitHub/GitLab/Bitbucket, portfolio site, technical writing, talks, package registries, and professional profile links).
2. Identify hiring constraints before analysis, especially target hubs or preferred locations.
3. Gather baseline context: activity recency, technical focus areas, ownership vs contribution patterns, consistency over time, and location signals.
4. Select 5-8 technical artifacts for deep review.
   - Prioritize recent, candidate-owned repositories when available.
   - Include at least one collaborative project and one solo project when possible.
   - Include at least one maintenance-heavy production artifact when available.
   - If code artifacts are sparse, include non-code technical artifacts (design docs, engineering blog posts, talks, packages, or technical issue threads).
5. Inspect each selected artifact for:
   - code organization and architecture clarity
   - testing depth, CI reliability, and quality gates
   - README and onboarding documentation quality
   - maintenance hygiene (dependency updates, release cadence, follow-through)
   - collaboration behavior in issues, PRs, and reviews
6. Record evidence-backed good and bad signals from each artifact.
   - Tie each signal to a concrete artifact (repository file path, PR, issue, commit, article, talk, or package).
   - Prefer recent evidence from roughly the last 12-24 months.
7. Infer likely location from explicit public signals and evaluate hub alignment.
   - Use profile location, recent work history locations, and time-zone patterns when explicit.
   - Classify as `in-hub`, `near-hub`, `outside-hub`, or `unknown`.
   - Add location confidence: `high`, `medium`, or `low`.
8. Score the candidate with the grading rubric in the reference file.
9. Produce a hiring brief in non-technical language, including confidence level and key unknowns.

## Output format

Main output must begin with the profile grade.

After the delivery block, write two parts in this order:

1. `Brief summary` (3-5 bullets, max 8 lines total, non-technical language). This must appear before detailed sections.
2. `Detailed report` with these sections:
   - `Profile grade` (`A`, `B`, `C`, `D`, or `F`) with one-sentence plain-language rationale.
   - `Likely location and hub fit` (`in-hub`, `near-hub`, `outside-hub`, or `unknown`) with evidence and confidence.
   - `Hiring recommendation` (`strong yes`, `yes`, `mixed`, or `no`) with one sentence.
   - `Executive summary` (3-6 bullets for non-technical readers).
   - `Why this grade` (4-8 bullets linking strongest positives and biggest risks).
   - `Evidence reviewed` (5-8 bullets, each naming source/artifact and evidence scope).
   - `Positive engineering signals` (4-10 bullets with evidence pointers).
   - `Negative engineering signals` (3-8 bullets with evidence pointers).
   - `Interview focus areas` (3-6 bullets).
   - `Confidence` (`high`, `medium`, or `low`) with one sentence on unknowns.

Delivery guidance:

- Always include this block first:
  `<delivery>`
  `mode: attachment`
  `attachment_prefix: candidate-brief`
  `</delivery>`
- Never use `mode: inline`.
- The response body after the block is written as attachment content.
- Keep plain markdown with short sections and bullets.

## Guardrails

- Do not infer sensitive personal attributes.
- Do not treat stars or forks as quality signals by themselves.
- Avoid overconfidence from limited public data.
- If data is sparse, stale, narrow, or lacks code evidence, explicitly say so and request more sources.
- Infer location only from explicit public evidence. Do not guess from name, photo, ethnicity, or nationality.
- Report location at city/region level only; never provide precise address data.
- If target hubs are not provided, state that hub fit is provisional and ask for the hub list.
- Keep language directly useful for non-technical hiring decisions.

See [candidate rubric](references/candidate-rubric.md) for scoring guidance.
