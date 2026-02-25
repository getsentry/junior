# Technical Communication Evaluation

Use this reference to evaluate clarity and depth of technical communication in public artifacts.

## Scope

- Review engineering blog posts, architecture write-ups, READMEs, design notes, talks, or technical issue analyses.
- Focus on whether the candidate can explain decisions and reduce ambiguity for collaborators.
- Evaluate only communication artifacts that are publicly accessible.

## Minimum evidence

- Target at least 1 substantial communication artifact when available.
- Prefer artifacts tied to real implementation work.
- If no public technical communication artifacts exist, mark `not-assessed`.

## What to inspect

- Clarity: concise explanation of problem, constraints, and solution.
- Decision quality: tradeoffs and alternatives are discussed explicitly.
- Audience fit: writing targets engineers effectively without unnecessary jargon.
- Reusability: content helps others onboard, debug, or extend systems.

## Authenticity checks

- Corroborate claims in writing with public code or delivery evidence when possible.
- Distinguish polished marketing copy from technically grounded material.
- If communication artifacts are mostly promotional and not technical, lower score.

## Not evaluable from public data

- Internal design docs or RFCs in private systems.
- Private architectural reviews or planning discussions.

## Scoring guide (1-5)

- `5`: clear, technically deep communication that improves execution quality.
- `4`: strong clarity and practical usefulness with minor gaps.
- `3`: mixed clarity or limited technical depth.
- `2`: weak communication quality or mostly superficial artifacts.
- `1`: no credible technical communication evidence.

## Required output shape

- `Technical communication evaluation`: include `evidence sufficiency` (`assessed`, `limited`, or `not-assessed`), score when assessable, positives, risks, and a `References` subsection.
- `References`: at least 1 citation when available (prefer 2+).
- Each citation should include URL + artifact pointer + short impact statement.
