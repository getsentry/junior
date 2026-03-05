# Candidate Rubric

Use this rubric to convert public technical evidence into a candidate brief.

## Public-only contract

- Use only directly observable public artifacts.
- Separate `observed facts` from `inference`.
- Treat self-claims as unverified until corroborated.
- Do not use private/internal signals.
- Personal references/endorsements are secondary context only, not primary evidence.
- Do not rely on `linkedin.com` scraping or LinkedIn profile caches/mirrors as required evidence inputs.

## Allowed source types

- GitHub/GitLab/Bitbucket repositories, commits, PRs, issues, releases, and CI results.
- Public CV/resume and public profile statements from independently accessible non-LinkedIn sources.
- Public technical talks, recordings, slide decks, and engineering articles.
- Public package registry pages and changelogs.
- Public speaking/event pages.
- Public social posts only when technically substantive.

## Out of scope (do not assess)

- Internal team collaboration behavior not visible publicly.
- Internal design discussions, incident response, on-call quality, or manager feedback.
- Internal throughput metrics or performance reviews.

## Required components

- GitHub/code evaluation
- CV and claim verification
- Public speaking and technical content evaluation
- Public presence evaluation
- Maintenance and operations evaluation (public repo history only)
- Location and hub evaluation

## Evidence sufficiency states

Each component must declare one state:

- `assessed`: enough public evidence for a reliable assessment.
- `limited`: partial public evidence; assessment possible with confidence penalty.
- `not-assessed`: insufficient public evidence.

Never assign a low score just because evidence is private/unavailable.

## Scored dimensions and weights

Score each assessed/limited dimension on 1-5:

- GitHub/code quality and complexity handling: 35%
- Maintenance and reliability from public repo history: 25%
- Public technical content quality (talks/articles/docs): 15%
- Public presence credibility and consistency: 10%
- CV claim verification coverage: 15%

Scoring rules:

- Calculate weighted score using only assessed/limited dimensions, then normalize to 100.
- If less than 60% of weight is assessable, cap recommendation at `mixed`.
- If GitHub/code evaluation is `not-assessed`, cap recommendation at `mixed`.

## CV claim verification score guidance

- `5`: most key claims are corroborated by independent public evidence.
- `4`: several key claims verified; minor gaps.
- `3`: mixed verification; meaningful unknowns.
- `2`: many key claims unverified or inconsistent.
- `1`: claims mostly unverified or contradicted.

## Location and hub alignment

- Infer location only from explicit public signals.
- Classify as `in-hub`, `near-hub`, `outside-hub`, or `unknown`.
- If location is `unknown`, cap confidence at `medium`.

## Grade mapping

- `A` (90-100)
- `B` (80-89)
- `C` (70-79)
- `D` (60-69)
- `F` (0-59)

## Recommendation calibration

- `strong yes`: exceptional, well-corroborated public evidence with low execution risk.
- `yes`: strong public evidence with manageable risks.
- `mixed`: upside exists but key unknowns or limited assessable evidence remain.
- `no`: verified public evidence shows high risk or weak capability.

## Confidence scoring

- `high`: broad, consistent, corroborated public evidence across components.
- `medium`: partial corroboration or multiple limited components.
- `low`: sparse, stale, conflicting, or mostly not-assessed evidence.

## Evidence style

- Every major component must include `References`.
- Every critical claim must cite a concrete source artifact.
- If evidence is missing, explicitly state `insufficient public evidence`.
